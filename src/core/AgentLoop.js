import { generateText, tool, stepCountIs } from "ai";
import { getModelWithFallback, resolveThinkingConfig } from "../models/ModelRouter.js";
import { config } from "../config/default.js";
import eventBus from "./EventBus.js";
import hookRunner from "../hooks/HookRunner.js";
import secretScanner from "../safety/SecretScanner.js";
import sandbox from "../safety/Sandbox.js";
import circuitBreaker from "../safety/CircuitBreaker.js";
import permissionGuard from "../safety/PermissionGuard.js";
import supervisor from "../agents/Supervisor.js";
import gitRollback from "../safety/GitRollback.js";
import { validateToolParams, getSchemaToolNames } from "../tools/schemas.js";
import toolSchemas from "../tools/schemas.js";
import { msgText } from "../utils/msgText.js";

/**
 * Core agent loop - uses Vercel AI SDK native tool calling.
 *
 * Tools have execute functions with guards baked in.
 * SDK handles the loop via stopWhen, message format, provider normalization.
 */
export async function runAgentLoop({
  messages: msgs,
  systemPrompt,
  tools,
  modelId = null,
  taskId = null,
  approvalMode = "auto",
  channelMeta = null,
  signal = null,
  steerQueue = null,
  apiKeys = {},
  onStepPersist = null,
}) {
  const selectedModelId = modelId || config.defaultModel;
  const { model, meta, modelId: resolvedModelId } = getModelWithFallback(selectedModelId, apiKeys);

  const thinkingConfig = resolveThinkingConfig(resolvedModelId, config.thinkingLevel);
  const thinkingParams = thinkingConfig?.thinkingParams || {};

  // Build set of known secret values to redact from tool outputs
  const _knownSecrets = new Set([
    ...Object.values(apiKeys),
    process.env.OPENAI_API_KEY,
    process.env.ANTHROPIC_API_KEY,
    process.env.GOOGLE_AI_API_KEY,
  ].filter((s) => s && s.length >= 8));

  function _redactKnownSecrets(text) {
    let out = text;
    for (const secret of _knownSecrets) {
      if (out.includes(secret)) out = out.replaceAll(secret, "[REDACTED:API_KEY]");
    }
    return out;
  }

  // ── Shared state for guards inside execute closures ──
  let stepCount = 0;
  const toolCallLog = [];
  const WRITE_TOOLS = new Set(["writeFile", "editFile", "applyPatch", "executeCommand", "sendEmail", "createDocument", "browserAction", "messageChannel"]);
  let gitSnapshotDone = false;
  let lastToolCall = null;
  let repeatCount = 0;

  // ── Build AI SDK tools with execute functions + guards ──
  const availableToolNames = new Set(getSchemaToolNames());
  for (const name of availableToolNames) {
    if (!tools[name]) availableToolNames.delete(name);
  }

  const aiTools = {};
  for (const name of availableToolNames) {
    const entry = toolSchemas[name];
    if (!entry) continue;

    aiTools[name] = tool({
      description: entry.description,
      inputSchema: entry.schema,
      execute: async (params) => {
        stepCount++;
        const tool_name = name;

        // Repeat detection
        const currentCall = JSON.stringify({ tool_name, params });
        if (currentCall === lastToolCall) {
          repeatCount++;
          if (repeatCount >= 2) {
            lastToolCall = null;
            repeatCount = 0;
            return `You are calling ${tool_name} with the same params repeatedly. Try a different approach.`;
          }
        } else {
          repeatCount = 0;
        }
        lastToolCall = currentCall;

        console.log(`[Step ${stepCount}] Tool: ${tool_name}`);
        console.log(`[Step ${stepCount}] Params: ${JSON.stringify(params)}`);

        eventBus.emitEvent("tool:before", { tool_name, params, stepCount, taskId });

        // Permission guard
        const permCheck = permissionGuard.check(tool_name, params);
        if (!permCheck.allowed) {
          console.log(`[Step ${stepCount}] BLOCKED by PermissionGuard: ${permCheck.reason}`);
          eventBus.emitEvent("audit:permission_denied", { tool_name, reason: permCheck.reason, taskId });
          return permCheck.reason;
        }

        // Circuit breaker
        if (circuitBreaker.isToolDisabled(tool_name)) {
          console.log(`[Step ${stepCount}] Tool "${tool_name}" temporarily disabled by circuit breaker`);
          return `Tool "${tool_name}" is temporarily disabled due to repeated failures. Try a different approach.`;
        }

        // Validate params
        const validation = validateToolParams(tool_name, params);
        if (!validation.success) {
          console.log(`[Step ${stepCount}] INVALID PARAMS: ${validation.error}`);
          return validation.error;
        }

        // Sandbox check for executeCommand
        if (tool_name === "executeCommand" && params.command) {
          const sandboxResult = sandbox.check(params.command);
          if (!sandboxResult.safe) {
            console.log(`[Step ${stepCount}] BLOCKED by sandbox: ${sandboxResult.reason}`);
            eventBus.emitEvent("audit:sandbox_blocked", { command: params.command, reason: sandboxResult.reason, taskId });
            return `${sandboxResult.reason}. This command is not allowed for safety reasons.`;
          }
        }

        // PreToolUse hooks
        const hookResult = await hookRunner.preToolUse(tool_name, params, taskId);
        if (hookResult.decision === "block") {
          console.log(`[Step ${stepCount}] BLOCKED by hook: ${hookResult.reason}`);
          eventBus.emitEvent("audit:hook_blocked", { tool_name, reason: hookResult.reason, taskId });
          return `Tool blocked by safety hook: ${hookResult.reason}. Try a different approach.`;
        }

        // Git snapshot before first write
        if (!gitSnapshotDone && WRITE_TOOLS.has(tool_name)) {
          gitRollback.snapshot(taskId);
          gitSnapshotDone = true;
        }

        // Execute the actual tool
        try {
          const toolStart = Date.now();
          const toolOutput = await Promise.resolve(tools[tool_name](params));
          const toolElapsed = Date.now() - toolStart;

          const outputStr = typeof toolOutput === "string" ? toolOutput : JSON.stringify(toolOutput);
          const preview = outputStr.slice(0, 300) + (outputStr.length > 300 ? "..." : "");

          console.log(`[Step ${stepCount}] Done in ${toolElapsed}ms`);
          console.log(`[Step ${stepCount}] Output: ${preview}`);

          toolCallLog.push({
            tool: tool_name, params, duration: toolElapsed,
            output_preview: outputStr.slice(0, 500),
            status: "success", step: stepCount,
          });

          eventBus.emitEvent("tool:after", { tool_name, params, stepCount, taskId, duration: toolElapsed, outputLength: outputStr.length });
          await hookRunner.postToolUse(tool_name, params, outputStr, taskId);

          // Redact secrets
          const safeOutput = _redactKnownSecrets(secretScanner.redactOutput(outputStr));
          if (safeOutput !== outputStr) {
            eventBus.emitEvent("audit:secret_detected", { tool_name, taskId });
          }

          circuitBreaker.recordSuccess(taskId);
          return safeOutput;
        } catch (error) {
          console.log(`[Step ${stepCount}] FAILED: ${error.message}`);
          toolCallLog.push({
            tool: tool_name, params, duration: 0,
            output_preview: `Error: ${error.message}`,
            status: "error", step: stepCount,
          });
          circuitBreaker.recordToolFailure(tool_name);
          eventBus.emitEvent("tool:after", { tool_name, params, stepCount, taskId, error: error.message });
          return `Error executing tool: ${error.message}`;
        }
      },
    });
  }

  console.log(`\n--- AGENT LOOP STARTED ---`);
  console.log(`Model: ${resolvedModelId}`);
  console.log(`User message: "${msgText(msgs[msgs.length - 1]?.content).slice(0, 120)}"`);;
  console.log(`Conversation history: ${msgs.length} message(s)`);

  // ── Inject steering messages before the call ──
  const inputMessages = [...msgs];
  if (steerQueue?.length > 0) {
    const userFollowUps = [];
    const steeringMessages = [];
    while (steerQueue.length > 0) {
      const item = steerQueue.shift();
      if (item && typeof item === "object" && item.type === "user") {
        userFollowUps.push(item.content);
      } else {
        steeringMessages.push(typeof item === "string" ? item : JSON.stringify(item));
      }
    }
    for (const text of steeringMessages) {
      inputMessages.push({ role: "user", content: `[Supervisor instruction]: ${text}` });
    }
    if (userFollowUps.length > 0) {
      inputMessages.push({
        role: "user",
        content: `[User follow-up while you are working. Acknowledge via replyToUser(), fold in, keep working.]\n\n${userFollowUps.join("\n\n")}`,
      });
    }
  }

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalSteps = 0;

  const startTime = Date.now();

  try {
    const result = await generateText({
      model,
      tools: aiTools,
      system: systemPrompt.content,
      messages: inputMessages,
      maxTokens: 8192,
      abortSignal: signal || undefined,
      stopWhen: stepCountIs(config.maxLoops || 30),
      ...thinkingParams,
      onStepFinish({ stepNumber, text, toolCalls, toolResults, finishReason, usage }) {
        totalSteps = stepNumber + 1;
        if (usage) {
          totalInputTokens += usage.inputTokens || usage.promptTokens || 0;
          totalOutputTokens += usage.outputTokens || usage.completionTokens || 0;
        }

        const tcNames = toolCalls?.map(tc => tc.toolName).join(", ") || "none";
        console.log(`[Step ${stepNumber + 1}] finishReason=${finishReason} tools=[${tcNames}]`);

        eventBus.emitEvent("model:called", {
          modelId: resolvedModelId,
          loopCount: stepNumber + 1,
          elapsed: 0,
          inputTokens: usage?.inputTokens || usage?.promptTokens || 0,
          outputTokens: usage?.outputTokens || usage?.completionTokens || 0,
        });

        // Persist step messages incrementally so crashes don't lose history
        if (onStepPersist) {
          try {
            const stepMessages = [];
            // Only persist tool-call/tool-result steps incrementally.
            // Text-only (final) responses are saved by TaskRunner after loop completes.
            if (toolCalls?.length > 0) {
              stepMessages.push({ role: "assistant", content: toolCalls.map(tc => ({ type: "tool-call", toolCallId: tc.toolCallId, toolName: tc.toolName, args: tc.args })) });
            }
            if (toolResults?.length > 0) {
              stepMessages.push({ role: "tool", content: toolResults.map(tr => ({ type: "tool-result", toolCallId: tr.toolCallId, toolName: tr.toolName, result: tr.result })) });
            }
            if (stepMessages.length > 0) onStepPersist(stepMessages);
          } catch (_) { /* never block the loop on persist errors */ }
        }

        // Drain steer queue between steps
        if (steerQueue?.length > 0) {
          while (steerQueue.length > 0) {
            const item = steerQueue.shift();
            console.log(`[AgentLoop] Steering received (step ${stepNumber}): ${JSON.stringify(item).slice(0, 80)}`);
          }
        }

        // Check supervisor kill
        if (supervisor.isKilled(taskId)) {
          console.log(`[AgentLoop] Task ${taskId?.slice(0, 8)} killed by Supervisor.`);
        }
      },
    });

    const elapsed = Date.now() - startTime;

    // Final usage from result
    if (result.usage) {
      // If onStepFinish already tracked, these may overlap — use result.usage as total
      totalInputTokens = result.usage.inputTokens || result.usage.promptTokens || totalInputTokens;
      totalOutputTokens = result.usage.outputTokens || result.usage.completionTokens || totalOutputTokens;
    }

    const finalText = result.text || "";
    const cost = {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      estimatedCost:
        (totalInputTokens / 1000) * meta.costPer1kInput +
        (totalOutputTokens / 1000) * meta.costPer1kOutput,
      modelCalls: totalSteps + 1,
      model: resolvedModelId,
    };

    console.log(`\n--- AGENT LOOP FINISHED ---`);
    console.log(`Stats: ${totalSteps + 1} steps | ${stepCount} tool calls | ${elapsed}ms | ~$${cost.estimatedCost.toFixed(4)}`);
    console.log(`Response: "${finalText.slice(0, 150)}${finalText.length > 150 ? "..." : ""}"`);

    // Build conversation messages for session persistence
    const conversationMessages = [...inputMessages, ...result.response.messages];

    return { text: finalText, messages: conversationMessages, cost, toolCalls: toolCallLog };
  } catch (error) {
    if (signal?.aborted || error.name === "AbortError") {
      console.log(`[AgentLoop] Aborted.`);
      return {
        text: "Agent was stopped.",
        messages: inputMessages,
        cost: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, estimatedCost: 0, modelCalls: totalSteps, model: resolvedModelId },
        toolCalls: toolCallLog,
      };
    }

    console.log(`[AgentLoop] Fatal error: ${error.message}`);
    return {
      text: `I encountered an error: ${error.message}`,
      messages: inputMessages,
      cost: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, estimatedCost: 0, modelCalls: totalSteps, model: resolvedModelId },
      toolCalls: toolCallLog,
    };
  }
}
