import { generateText } from "ai";
import { getModelWithFallback, resolveThinkingConfig } from "../models/ModelRouter.js";
import { compactIfNeeded, estimateTokens } from "./Compaction.js";
import { config } from "../config/default.js";
import eventBus from "./EventBus.js";
import hookRunner from "../hooks/HookRunner.js";
import secretScanner from "../safety/SecretScanner.js";
import sandbox from "../safety/Sandbox.js";
import circuitBreaker from "../safety/CircuitBreaker.js";
import permissionGuard from "../safety/PermissionGuard.js";
import supervisor from "../agents/Supervisor.js";
import gitRollback from "../safety/GitRollback.js";
import { validateToolParams, buildAITools, getSchemaToolNames } from "../tools/schemas.js";

/**
 * Core agent loop - model-agnostic via Vercel AI SDK.
 *
 * Uses native tool calling (generateText + tools) instead of structured output.
 * The SDK handles provider-specific schema normalization automatically.
 *
 * Flow per iteration:
 * 1. Send messages + tool definitions to model via generateText
 * 2. If model returns tool calls → execute with guards → feed results back → loop
 * 3. If model returns text (no tools) → final response → return
 * 4. Compaction when approaching context limit
 * 5. Repeat detection, max loop safety, stuck agent recovery
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

  // Build native AI SDK tool definitions (no execute — we dispatch manually)
  const availableToolNames = new Set(getSchemaToolNames());
  // Only include tools that exist in the tools map
  for (const name of availableToolNames) {
    if (!tools[name]) availableToolNames.delete(name);
  }
  const aiTools = buildAITools(availableToolNames);

  let messages = [systemPrompt, ...msgs];
  let stepCount = 0;
  let loopCount = 0;
  let lastToolCall = null;
  let repeatCount = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let consecutiveErrors = 0;
  const toolCallLog = [];

  const WRITE_TOOLS = new Set(["writeFile", "editFile", "applyPatch", "executeCommand", "sendEmail", "createDocument", "browserAction", "messageChannel"]);
  let gitSnapshotDone = false;

  console.log(`\n--- AGENT LOOP STARTED ---`);
  console.log(`Model: ${resolvedModelId}`);
  console.log(`User message: "${msgs[msgs.length - 1]?.content?.slice(0, 120)}"`);
  console.log(`Conversation history: ${msgs.length} message(s)`);

  while (true) {
    loopCount++;

    // ── Break point 1: AbortController signal ──
    if (signal?.aborted) {
      console.log(`[AgentLoop] Task ${taskId?.slice(0, 8)} aborted via AbortController.`);
      return {
        text: "Agent was stopped by the supervisor.",
        messages: messages.slice(1),
        cost: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, estimatedCost: 0, modelCalls: loopCount, model: resolvedModelId },
        toolCalls: toolCallLog,
      };
    }

    // ── Break point 2: Supervisor kill flag ──
    if (supervisor.isKilled(taskId)) {
      console.log(`[AgentLoop] Task ${taskId?.slice(0, 8)} was killed by Supervisor. Stopping.`);
      return {
        text: "Task was stopped by the safety supervisor due to excessive tool usage or a dangerous pattern.",
        messages: messages.slice(1),
        cost: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, estimatedCost: 0, modelCalls: loopCount, model: resolvedModelId },
        toolCalls: toolCallLog,
      };
    }

    // ── Steering: drain steerQueue between tool calls ──
    if (steerQueue?.length > 0) {
      const userFollowUps = [];
      const steeringMessages = [];

      while (steerQueue.length > 0) {
        const item = steerQueue.shift();
        if (item && typeof item === "object" && item.type === "user") {
          console.log(`[AgentLoop] User follow-up injected: "${item.content.slice(0, 80)}"`);
          userFollowUps.push(item.content);
        } else {
          const text = typeof item === "string" ? item : JSON.stringify(item);
          console.log(`[AgentLoop] Steering instruction received: "${text.slice(0, 80)}"`);
          steeringMessages.push(text);
        }
      }

      for (const text of steeringMessages) {
        messages.push({ role: "user", content: `[Supervisor instruction]: ${text}` });
      }

      if (userFollowUps.length > 0) {
        const combined = userFollowUps.join("\n\n");
        messages.push({
          role: "user",
          content: `[User sent a follow-up message while you are working. Acknowledge it — use replyToUser() to send a brief acknowledgment or progress update, then incorporate their input into your current work. Do NOT stop or restart — continue working with the new information folded in.]\n\n${combined}`,
        });
      }
    }

    if (loopCount > config.maxLoops + 3) {
      console.log(`[FATAL] Agent exceeded hard limit (${config.maxLoops + 3}). Forcing exit.`);
      return {
        text: "Task stopped: exceeded maximum iterations. Here is what was accomplished before stopping.",
        messages: messages.slice(1),
        cost: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, estimatedCost: 0, modelCalls: loopCount, model: resolvedModelId },
        toolCalls: toolCallLog,
      };
    }

    if (loopCount > config.maxLoops) {
      console.log(`[WARN] Hit max loop limit (${config.maxLoops}). Forcing agent to stop.`);
      messages.push({
        role: "user",
        content: `You have used ${config.maxLoops} iterations. You must stop now. Summarize what you have done so far.`,
      });
    }

    // Compaction check before model call
    messages = await compactIfNeeded(messages, meta, taskId, tools);

    console.log(`\n[Loop ${loopCount}] Sending ${messages.length} messages (~${estimateTokens(messages)} tokens) to ${resolvedModelId}...`);

    const startTime = Date.now();

    try {
      const result = await generateText({
        model,
        tools: aiTools,
        messages,
        maxTokens: 8192,
        abortSignal: signal || undefined,
        ...thinkingParams,
      });

      const elapsed = Date.now() - startTime;
      consecutiveErrors = 0;

      // Track token usage
      const usage = result.usage;
      if (usage) {
        totalInputTokens += usage.promptTokens || 0;
        totalOutputTokens += usage.completionTokens || 0;
      } else {
        console.log(`[Loop ${loopCount}] WARNING: No token usage returned.`);
        const inputChars = messages.reduce((sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0), 0);
        totalInputTokens += Math.ceil(inputChars / 4);
        totalOutputTokens += Math.ceil((result.text || "").length / 4);
      }

      eventBus.emitEvent("model:called", {
        modelId: resolvedModelId,
        loopCount,
        elapsed,
        inputTokens: usage?.promptTokens || 0,
        outputTokens: usage?.completionTokens || 0,
      });

      const hasToolCalls = result.toolCalls && result.toolCalls.length > 0;

      console.log(
        `[Loop ${loopCount}] Model responded in ${elapsed}ms | toolCalls=${hasToolCalls ? result.toolCalls.length : 0} | finishReason=${result.finishReason}`
      );

      // --- Tool call handling ---
      if (hasToolCalls) {
        // Add the assistant's tool-call message to conversation
        messages.push(...result.response.messages);

        const toolResults = [];

        for (const tc of result.toolCalls) {
          stepCount++;
          const tool_name = tc.toolName;
          const params = tc.args || {};

          // Repeat detection
          const currentCall = JSON.stringify({ tool_name, params });
          if (currentCall === lastToolCall) {
            repeatCount++;
            console.log(`[WARN] Same tool call repeated ${repeatCount + 1} times in a row`);
            if (repeatCount >= 2) {
              console.log(`[WARN] Agent stuck repeating "${tool_name}". Forcing it to move on.`);
              messages.push({
                role: "user",
                content: `You are calling ${tool_name} with the same params repeatedly. This is not working. Try a different approach or give the user your final answer.`,
              });
              lastToolCall = null;
              repeatCount = 0;
              break;
            }
          } else {
            repeatCount = 0;
          }
          lastToolCall = currentCall;

          console.log(`[Step ${stepCount}] Tool: ${tool_name}`);
          console.log(`[Step ${stepCount}] Params: ${JSON.stringify(params)}`);

          eventBus.emitEvent("tool:before", { tool_name, params, stepCount, taskId });

          // Permission guard check
          const permCheck = permissionGuard.check(tool_name, params);
          if (!permCheck.allowed) {
            console.log(`[Step ${stepCount}] BLOCKED by PermissionGuard: ${permCheck.reason}`);
            eventBus.emitEvent("audit:permission_denied", { tool_name, reason: permCheck.reason, taskId });
            toolResults.push({ type: "tool-result", toolCallId: tc.toolCallId, toolName: tool_name, result: permCheck.reason });
            continue;
          }

          // Circuit breaker check
          if (circuitBreaker.isToolDisabled(tool_name)) {
            console.log(`[Step ${stepCount}] Tool "${tool_name}" temporarily disabled by circuit breaker`);
            toolResults.push({ type: "tool-result", toolCallId: tc.toolCallId, toolName: tool_name, result: `Tool "${tool_name}" is temporarily disabled due to repeated failures. Try a different approach.` });
            continue;
          }

          // Validate params against tool schema
          const validation = validateToolParams(tool_name, params);
          if (!validation.success) {
            console.log(`[Step ${stepCount}] INVALID PARAMS: ${validation.error}`);
            toolResults.push({ type: "tool-result", toolCallId: tc.toolCallId, toolName: tool_name, result: validation.error });
            continue;
          }

          // Sandbox check for executeCommand
          if (tool_name === "executeCommand" && params.command) {
            const sandboxResult = sandbox.check(params.command);
            if (!sandboxResult.safe) {
              console.log(`[Step ${stepCount}] BLOCKED by sandbox: ${sandboxResult.reason}`);
              eventBus.emitEvent("audit:sandbox_blocked", { command: params.command, reason: sandboxResult.reason, taskId });
              toolResults.push({ type: "tool-result", toolCallId: tc.toolCallId, toolName: tool_name, result: `${sandboxResult.reason}. This command is not allowed for safety reasons.` });
              continue;
            }
          }

          // Run PreToolUse hooks
          const hookResult = await hookRunner.preToolUse(tool_name, params, taskId);
          if (hookResult.decision === "block") {
            console.log(`[Step ${stepCount}] BLOCKED by hook: ${hookResult.reason}`);
            eventBus.emitEvent("audit:hook_blocked", { tool_name, reason: hookResult.reason, taskId });
            toolResults.push({ type: "tool-result", toolCallId: tc.toolCallId, toolName: tool_name, result: `Tool blocked by safety hook: ${hookResult.reason}. Try a different approach.` });
            continue;
          }

          // Git snapshot — before the first write tool in this task
          if (!gitSnapshotDone && WRITE_TOOLS.has(tool_name)) {
            gitRollback.snapshot(taskId);
            gitSnapshotDone = true;
          }

          // Execute the tool
          if (tools[tool_name]) {
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

              // Run PostToolUse hooks
              await hookRunner.postToolUse(tool_name, params, outputStr, taskId);

              // Scan output for secrets and redact
              const safeOutput = _redactKnownSecrets(secretScanner.redactOutput(outputStr));
              if (safeOutput !== outputStr) {
                eventBus.emitEvent("audit:secret_detected", { tool_name, taskId });
              }

              circuitBreaker.recordSuccess(taskId);

              toolResults.push({ type: "tool-result", toolCallId: tc.toolCallId, toolName: tool_name, result: safeOutput });
            } catch (error) {
              console.log(`[Step ${stepCount}] FAILED: ${error.message}`);
              toolCallLog.push({
                tool: tool_name, params, duration: 0,
                output_preview: `Error: ${error.message}`,
                status: "error", step: stepCount,
              });
              circuitBreaker.recordToolFailure(tool_name);
              eventBus.emitEvent("tool:after", { tool_name, params, stepCount, taskId, error: error.message });
              toolResults.push({ type: "tool-result", toolCallId: tc.toolCallId, toolName: tool_name, result: `Error executing tool: ${error.message}` });
            }
          } else {
            console.log(`[Step ${stepCount}] Unknown tool: ${tool_name} - skipping`);
            toolResults.push({ type: "tool-result", toolCallId: tc.toolCallId, toolName: tool_name, result: `Unknown tool: ${tool_name}. Available tools: ${Object.keys(tools).join(", ")}` });
          }
        }

        // Add tool results to conversation
        if (toolResults.length > 0) {
          messages.push({ role: "tool", content: toolResults });
        }
        continue;
      }

      // --- Final response handling ---
      const finalText = result.text || "";

      if (!finalText.trim()) {
        console.log(`[Loop ${loopCount}] Model returned empty text — asking for summary`);
        messages.push(...(result.response.messages || []));
        messages.push({
          role: "user",
          content: "Provide a text summary of what you did.",
        });
        continue;
      }

      const cost = {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        estimatedCost:
          (totalInputTokens / 1000) * meta.costPer1kInput +
          (totalOutputTokens / 1000) * meta.costPer1kOutput,
        modelCalls: loopCount,
        model: resolvedModelId,
      };

      console.log(`\n--- AGENT LOOP FINISHED ---`);
      console.log(`Stats: ${loopCount} loops | ${stepCount} tool calls | ~$${cost.estimatedCost.toFixed(4)}`);
      console.log(`Response: "${finalText.slice(0, 150)}${finalText.length > 150 ? "..." : ""}"`);

      // Add assistant's final response to conversation history
      messages.push({ role: "assistant", content: finalText });

      const conversationMessages = messages.slice(1);
      return { text: finalText, messages: conversationMessages, cost, toolCalls: toolCallLog };
    } catch (error) {
      // Abort signal fires as an error — exit cleanly
      if (signal?.aborted || error.name === "AbortError") {
        console.log(`[Loop ${loopCount}] Aborted mid-call.`);
        return {
          text: "Agent was stopped by the supervisor.",
          messages: messages.slice(1),
          cost: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, estimatedCost: 0, modelCalls: loopCount, model: resolvedModelId },
          toolCalls: toolCallLog,
        };
      }

      consecutiveErrors++;
      console.log(`[Loop ${loopCount}] Model call failed (${consecutiveErrors}/5): ${error.message}`);

      if (consecutiveErrors >= 5) {
        console.log(`[FATAL] 5 consecutive model failures. Stopping.`);
        return {
          text: `I encountered an error while processing your request: ${error.message}`,
          messages: messages.slice(1),
          cost: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, estimatedCost: 0, modelCalls: loopCount, model: resolvedModelId },
          toolCalls: toolCallLog,
        };
      }

      const backoffMs = Math.min(1000 * Math.pow(2, consecutiveErrors - 1), 16000);
      console.log(`[Loop ${loopCount}] Retrying in ${backoffMs}ms...`);
      await new Promise(resolve => setTimeout(resolve, backoffMs));

      messages.push({
        role: "user",
        content: `[System: previous call failed: ${error.message}] Try again with the same approach, or provide your final answer.`,
      });
      continue;
    }
  }
}
