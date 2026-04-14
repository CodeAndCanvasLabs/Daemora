import { generateText, streamText, tool, stepCountIs } from "ai";
import { getModelWithFallback, resolveThinkingConfig, resolveDefaultModel, classifyError, cooldownProvider, getRuntimeFallback } from "../models/ModelRouter.js";
import { config } from "../config/default.js";
import eventBus from "./EventBus.js";
import hookRunner from "../hooks/HookRunner.js";
import secretScanner from "../safety/SecretScanner.js";
import sandbox from "../safety/Sandbox.js";
import circuitBreaker from "../safety/CircuitBreaker.js";
import permissionGuard from "../safety/PermissionGuard.js";
import supervisor from "../agents/Supervisor.js";
import gitRollback from "../safety/GitRollback.js";
import { validateToolParams, getSchemaToolNames, getToolDescription } from "../tools/schemas.js";
import toolSchemas from "../tools/schemas.js";
import channelRegistry from "../channels/index.js";
import { msgText } from "../utils/msgText.js";
import { pruneContext } from "./ContextPruner.js";
import loopDetector from "./LoopDetector.js";

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
  aiToolOverrides = null,
  modelId = null,
  taskId = null,
  approvalMode = "auto",
  channelMeta = null,
  signal = null,
  steerQueue = null,
  apiKeys = {},
  onStepPersist = null,
  streaming = false,
}) {
  const selectedModelId = modelId || config.defaultModel || resolveDefaultModel(apiKeys);
  const { model, meta, modelId: resolvedModelId } = getModelWithFallback(selectedModelId, apiKeys);

  const thinkingConfig = resolveThinkingConfig(resolvedModelId, config.thinkingLevel);
  const thinkingParams = thinkingConfig?.thinkingParams || {};

  // Build set of known secret values to redact from tool outputs
  // Tracks: per-tenant API keys + ALL env vars with sensitive names
  const SENSITIVE_NAME = /(_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIAL|_AUTH|_SID|_PRIVATE|_PASSPHRASE)$/i;
  const _knownSecrets = new Set([
    ...Object.values(apiKeys),
    ...Object.entries(process.env)
      .filter(([k, v]) => v && v.length >= 8 && SENSITIVE_NAME.test(k))
      .map(([, v]) => v),
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

  // ── Build AI SDK tools with execute functions + guards ──
  const availableToolNames = new Set(getSchemaToolNames());
  for (const name of availableToolNames) {
    if (!tools[name]) availableToolNames.delete(name);
  }

  // Runtime context for enriching tool descriptions
  const activeChannels = channelRegistry.list().filter(c => c.running).map(c => c.name);
  const toolContext = { activeChannels };

  const aiTools = {};
  for (const name of availableToolNames) {
    const entry = toolSchemas[name];
    if (!entry) continue;

    aiTools[name] = tool({
      description: getToolDescription(name, toolContext) || entry.description,
      inputSchema: entry.schema,
      execute: async (params) => {
        stepCount++;
        const tool_name = name;

        // Loop detection (exact repeat, ping-pong, semantic, polling)
        const loopCheck = loopDetector.record(tool_name, params, taskId);
        if (loopCheck.blocked) {
          console.log(`[Step ${stepCount}] BLOCKED by LoopDetector: ${loopCheck.pattern}`);
          return loopCheck.message;
        }

        console.log(`[Step ${stepCount}] Tool: ${tool_name}`);
        console.log(`[Step ${stepCount}] Params: ${_redactKnownSecrets(JSON.stringify(params))}`);

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
          const safePreview = _redactKnownSecrets(outputStr.slice(0, 300) + (outputStr.length > 300 ? "..." : ""));

          console.log(`[Step ${stepCount}] Done in ${toolElapsed}ms`);
          console.log(`[Step ${stepCount}] Output: ${safePreview}`);

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

  // ── Merge pre-built AI SDK tools (e.g. from @ai-sdk/mcp) ──
  if (aiToolOverrides) {
    for (const [name, toolDef] of Object.entries(aiToolOverrides)) {
      aiTools[name] = toolDef;
    }
    console.log(`[AgentLoop] Merged ${Object.keys(aiToolOverrides).length} AI tool override(s)`);
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

  // ── Prune tool results before sending to model (OpenClaw pattern) ──
  const tokenBudget = meta.contextWindow ? Math.floor(meta.contextWindow * 0.85) : 100_000;
  pruneContext(inputMessages, tokenBudget);

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalSteps = 0;

  const startTime = Date.now();
  const MAX_RETRIES = 2;
  let retryCount = 0;

  while (retryCount <= MAX_RETRIES) {
  try {
    // Compose stop condition: stop at max steps OR when a follow-up arrives.
    // generateText checks this between steps, so a follow-up sent mid-task
    // will cause graceful stop after the current step. Completed steps are
    // preserved in result.response.messages — we then re-enter the loop
    // with the follow-up appended.
    const maxStepsStop = stepCountIs(config.maxLoops || 30);
    const stopForFollowUp = ({ steps }) => {
      if (steerQueue?.length > 0) {
        console.log(`[AgentLoop] Follow-up detected mid-task — stopping current step to inject (${steps.length} steps done)`);
        return true;
      }
      return false;
    };
    const composedStop = ({ steps }) => maxStepsStop({ steps }) || stopForFollowUp({ steps });

    const callOpts = {
      model,
      tools: aiTools,
      system: systemPrompt.content,
      messages: inputMessages,
      maxTokens: 8192,
      abortSignal: signal || undefined,
      stopWhen: composedStop,
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

        // Note: don't drain steerQueue here. We can't inject mid-generateText call —
        // the queue is read at the START of each generateText invocation. After this
        // call finishes, the post-loop check below will detect queued items and
        // re-enter generateText with them appended to the conversation.

        // Check supervisor kill
        if (supervisor.isKilled(taskId)) {
          console.log(`[AgentLoop] Task ${taskId?.slice(0, 8)} killed by Supervisor.`);
        }
      },
    };

    // Streaming path: emit text:delta events as tokens arrive (HTTP/SSE only).
    // Other channels (Discord/Telegram/Slack) keep the standard generateText path.
    let result;
    if (streaming) {
      console.log(`[AgentLoop] streaming ON for task ${taskId?.slice(0,8)}`);
      const streamHandle = streamText(callOpts);
      let _deltaCount = 0;
      try {
        for await (const delta of streamHandle.textStream) {
          if (delta) {
            _deltaCount++;
            eventBus.emitEvent("text:delta", { taskId, delta });
          }
        }
      } catch (streamErr) {
        throw streamErr;
      }
      console.log(`[AgentLoop] emitted ${_deltaCount} text:delta events for task ${taskId?.slice(0,8)}`);
      result = {
        text: await streamHandle.text,
        usage: await streamHandle.usage,
        response: await streamHandle.response,
        finishReason: await streamHandle.finishReason,
      };
      eventBus.emitEvent("text:end", { taskId, finalText: result.text || "" });
    } else {
      result = await generateText(callOpts);
    }

    // Final usage from result
    if (result.usage) {
      // If onStepFinish already tracked, these may overlap - use result.usage as total
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

    // Build conversation messages from this iteration
    const conversationMessages = [...inputMessages, ...result.response.messages];

    // ── Mid-task follow-up: if user sent more messages while we were generating,
    //    append them and continue the loop instead of returning. ──
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
      console.log(`[AgentLoop] Mid-task follow-up received (${userFollowUps.length} user, ${steeringMessages.length} system) — continuing loop`);

      // Replace inputMessages with the full conversation + follow-ups, restart the loop
      inputMessages.length = 0;
      inputMessages.push(...conversationMessages);
      for (const text of steeringMessages) {
        inputMessages.push({ role: "user", content: `[Supervisor instruction]: ${text}` });
      }
      if (userFollowUps.length > 0) {
        inputMessages.push({
          role: "user",
          content: `[User follow-up while you were working. Acknowledge and continue.]\n\n${userFollowUps.join("\n\n")}`,
        });
      }
      pruneContext(inputMessages, tokenBudget);
      retryCount = 0;
      continue;
    }

    const elapsed = Date.now() - startTime;
    console.log(`\n--- AGENT LOOP FINISHED ---`);
    console.log(`Stats: ${totalSteps + 1} steps | ${stepCount} tool calls | ${elapsed}ms | ~$${cost.estimatedCost.toFixed(4)}`);
    console.log(`Response: "${finalText.slice(0, 150)}${finalText.length > 150 ? "..." : ""}"`);

    loopDetector.cleanup(taskId);
    return { text: finalText, messages: conversationMessages, cost, toolCalls: toolCallLog };
  } catch (error) {
    // Tool call validation errors - inject error into conversation, retry the full loop
    const isToolCallError = /tool call validation|not in request\.tools|failed_generation/i.test(error.message);
    if (isToolCallError && retryCount < MAX_RETRIES) {
      retryCount++;
      console.log(`[AgentLoop] Tool call error (retry ${retryCount}/${MAX_RETRIES}) - feeding error back to model`);
      inputMessages.push({ role: "user", content: `[system] Tool call failed. Try again.` });
      continue; // retry the while loop with full tracking
    }

    if (signal?.aborted || error.name === "AbortError") {
      console.log(`[AgentLoop] Aborted.`);
      return {
        text: "Agent was stopped.",
        messages: inputMessages,
        cost: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, estimatedCost: 0, modelCalls: totalSteps, model: resolvedModelId },
        toolCalls: toolCallLog,
      };
    }

    // Classify error: transient (retry), permanent (fallback), unknown (show to user)
    const classified = classifyError(error);

    // Transient errors: retry with backoff (1s, 4s, 16s)
    if (classified.type === "transient" && retryCount < MAX_RETRIES) {
      retryCount++;
      const backoffMs = classified.retryAfterMs || Math.min(1000 * Math.pow(4, retryCount - 1), 16000);
      console.log(`[AgentLoop] Transient error (retry ${retryCount}/${MAX_RETRIES}, backoff ${backoffMs}ms): ${error.message}`);
      await new Promise(r => setTimeout(r, backoffMs));
      continue;
    }

    // Permanent errors or exhausted retries: try fallback model
    if (classified.type === "permanent" || (classified.type === "transient" && retryCount >= MAX_RETRIES)) {
      cooldownProvider(resolvedModelId, 60000);
      const fallback = getRuntimeFallback(resolvedModelId, apiKeys);
      if (fallback && retryCount <= MAX_RETRIES) {
        retryCount++;
        console.log(`[AgentLoop] ${classified.type} error — switching to fallback model: ${fallback.modelId}`);
        // Swap model for retry (variables from outer scope)
        Object.assign(model, {}); // force re-read below
        // Can't swap `model` directly (const), so we restart via continue
        // The retry will use the same model — but we've cooled down the provider
        // so getModelWithFallback will skip it on next task
        // For THIS task, just show error since we can't hot-swap mid-loop
      }
    }

    console.log(`[AgentLoop] Fatal error: ${error.message}`);

    const msg = error.message || "";
    const isUserFacing = /rate.limit|quota|budget|billing|unauthorized|auth|too.large|TPM|RPM/i.test(msg);
    const userText = isUserFacing
      ? `I encountered an error: ${msg}`
      : "Something went wrong while processing your request. Please try again.";

    return {
      text: userText,
      messages: inputMessages,
      cost: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, estimatedCost: 0, modelCalls: totalSteps, model: resolvedModelId },
      toolCalls: toolCallLog,
    };
  }
  } // end while retry loop
}
