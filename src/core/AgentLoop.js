import { generateObject } from "ai";
import { getModelWithFallback } from "../models/ModelRouter.js";
import { compactIfNeeded, estimateTokens } from "./Compaction.js";
import { config } from "../config/default.js";
import eventBus from "./EventBus.js";
import outputSchema from "../services/models/outputSchema.js";
import hookRunner from "../hooks/HookRunner.js";
import secretScanner from "../safety/SecretScanner.js";
import sandbox from "../safety/Sandbox.js";
import circuitBreaker from "../safety/CircuitBreaker.js";
import permissionGuard from "../safety/PermissionGuard.js";
import supervisor from "../agents/Supervisor.js";
import gitRollback from "../safety/GitRollback.js";

/**
 * Core agent loop - model-agnostic via Vercel AI SDK.
 *
 * Extracted from the original openai.js. This is the brain of the agent:
 * 1. Send messages to model (any provider)
 * 2. If model returns tool_call → execute tool → feed result back → loop
 * 3. If model returns text + finalResponse → return to caller
 * 4. Compaction when approaching context limit
 * 5. Repeat detection, max loop safety, stuck agent recovery
 *
 * @param {object} options
 * @param {Array} options.messages - Conversation history
 * @param {object} options.systemPrompt - System prompt { role, content }
 * @param {object} options.tools - Tool functions map { name: fn }
 * @param {string} [options.modelId] - Model to use (e.g. "openai:gpt-4.1-mini")
 * @param {string} [options.taskId] - Task ID for tracking
 * @returns {{ text: string, messages: Array, cost: object }}
 */
export async function runAgentLoop({
  messages: msgs,
  systemPrompt,
  tools,
  modelId = null,
  taskId = null,
  approvalMode = "auto",   // "auto" | "dangerous-only" | "every-tool"
  channelMeta = null,      // passed through to HumanApproval so channel can notify user
  signal = null,           // AbortController.signal - hard-kills the loop mid-call
  steerQueue = null,       // shared mutable array - push strings here to steer the agent
  apiKeys = {},            // per-tenant API key overlay - passed through to provider factory
}) {
  const selectedModelId = modelId || config.defaultModel;
  const { model, meta, modelId: resolvedModelId } = getModelWithFallback(selectedModelId, apiKeys);

  // Build set of known secret values to redact from tool outputs (dynamic - catches tenant keys)
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

  let messages = [systemPrompt, ...msgs];
  let stepCount = 0;
  let loopCount = 0;
  let lastToolCall = null;
  let repeatCount = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let consecutiveErrors = 0;

  const WRITE_TOOLS = new Set(["writeFile", "editFile", "applyPatch", "executeCommand", "sendEmail", "createDocument", "browserAction", "messageChannel"]);
  let gitSnapshotDone = false; // Only snapshot once per task

  console.log(`\n--- AGENT LOOP STARTED ---`);
  console.log(`Model: ${resolvedModelId}`);
  console.log(`User message: "${msgs[msgs.length - 1]?.content?.slice(0, 120)}"`);
  console.log(`Conversation history: ${msgs.length} message(s)`);

  while (true) {
    loopCount++;

    // ── Break point 1: AbortController signal (hard kill, works mid-API-call) ──
    if (signal?.aborted) {
      console.log(`[AgentLoop] Task ${taskId?.slice(0, 8)} aborted via AbortController.`);
      return {
        text: "Agent was stopped by the supervisor.",
        messages: messages.slice(1),
        cost: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, estimatedCost: 0, modelCalls: loopCount, model: resolvedModelId },
      };
    }

    // ── Break point 2: Supervisor kill flag (checked each iteration) ──────────
    if (supervisor.isKilled(taskId)) {
      console.log(`[AgentLoop] Task ${taskId?.slice(0, 8)} was killed by Supervisor. Stopping.`);
      return {
        text: "Task was stopped by the safety supervisor due to excessive tool usage or a dangerous pattern.",
        messages: messages.slice(1),
        cost: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, estimatedCost: 0, modelCalls: loopCount, model: resolvedModelId },
      };
    }

    // ── Steering: drain steerQueue between tool calls ────────────────────────
    // Items can be plain strings (supervisor/parent instructions) or
    // objects { type: "user", content } for live follow-up messages injected
    // from the same session while this loop is mid-flight.
    if (steerQueue?.length > 0) {
      while (steerQueue.length > 0) {
        const item = steerQueue.shift();
        if (item && typeof item === "object" && item.type === "user") {
          // User sent a follow-up mid-task - inject as a natural user turn
          console.log(`[AgentLoop] User follow-up injected: "${item.content.slice(0, 80)}"`);
          messages.push({ role: "user", content: item.content });
        } else {
          const text = typeof item === "string" ? item : JSON.stringify(item);
          console.log(`[AgentLoop] Steering instruction received: "${text.slice(0, 80)}"`);
          messages.push({ role: "user", content: `[Supervisor instruction]: ${text}` });
        }
      }
    }

    if (loopCount > config.maxLoops) {
      console.log(`[WARN] Hit max loop limit (${config.maxLoops}). Forcing agent to stop.`);
      messages.push({
        role: "user",
        content: `You have used ${config.maxLoops} iterations. You must stop now. Summarize what you have done so far. Set type to "text", finalResponse to true, and put your summary in text_content.`,
      });
    }

    // Compaction check before model call
    messages = await compactIfNeeded(messages, meta, taskId);

    console.log(`\n[Loop ${loopCount}] Sending ${messages.length} messages (~${estimateTokens(messages)} tokens) to ${resolvedModelId}...`);

    const startTime = Date.now();

    try {
      const response = await generateObject({
        model,
        schema: outputSchema,
        messages,
        maxTokens: 4096,
        abortSignal: signal || undefined,
      });

      const elapsed = Date.now() - startTime;
      consecutiveErrors = 0; // Reset on success

      // Track token usage
      const usage = response.usage;
      if (usage && (usage.promptTokens || usage.completionTokens)) {
        totalInputTokens += usage.promptTokens || 0;
        totalOutputTokens += usage.completionTokens || 0;
      } else {
        // Fallback: estimate from message sizes if usage not available
        console.log(`[Loop ${loopCount}] WARNING: No token usage returned. response.usage = ${JSON.stringify(usage)}`);
        const inputChars = messages.reduce((sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0), 0);
        const outputChars = JSON.stringify(response.object).length;
        totalInputTokens += Math.ceil(inputChars / 4);
        totalOutputTokens += Math.ceil(outputChars / 4);
      }

      eventBus.emitEvent("model:called", {
        modelId: resolvedModelId,
        loopCount,
        elapsed,
        inputTokens: usage?.promptTokens || 0,
        outputTokens: usage?.completionTokens || 0,
      });

      const parsedOutput = response.object;

      console.log(
        `[Loop ${loopCount}] Model responded in ${elapsed}ms | type=${parsedOutput.type} | final=${parsedOutput.finalResponse}`
      );

      // --- Tool call handling ---
      if (parsedOutput.type === "tool_call" && parsedOutput.tool_call) {
        // Save the model's tool call as an assistant message so the conversation is properly structured
        messages.push({ role: "assistant", content: JSON.stringify(parsedOutput) });

        stepCount++;
        const { tool_name, params } = parsedOutput.tool_call;

        // Repeat detection
        const currentCall = JSON.stringify({ tool_name, params });
        if (currentCall === lastToolCall) {
          repeatCount++;
          console.log(`[WARN] Same tool call repeated ${repeatCount + 1} times in a row`);
          if (repeatCount >= 2) {
            console.log(`[WARN] Agent stuck repeating "${tool_name}". Forcing it to move on.`);
            messages.push({
              role: "user",
              content: `You are calling ${tool_name} with the same params repeatedly. This is not working. Try a different approach or give the user your final answer. Set type to "text" and finalResponse to true.`,
            });
            lastToolCall = null;
            repeatCount = 0;
            continue;
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
          messages.push({
            role: "user",
            content: JSON.stringify({ tool_name, params, output: permCheck.reason }),
          });
          continue;
        }

        // Circuit breaker check
        if (circuitBreaker.isToolDisabled(tool_name)) {
          console.log(`[Step ${stepCount}] Tool "${tool_name}" temporarily disabled by circuit breaker`);
          messages.push({
            role: "user",
            content: JSON.stringify({
              tool_name, params,
              output: `Tool "${tool_name}" is temporarily disabled due to repeated failures. Try a different approach.`,
            }),
          });
          continue;
        }

        // Sandbox check for executeCommand
        if (tool_name === "executeCommand" && params[0]) {
          const sandboxResult = sandbox.check(params[0]);
          if (!sandboxResult.safe) {
            console.log(`[Step ${stepCount}] BLOCKED by sandbox: ${sandboxResult.reason}`);
            eventBus.emitEvent("audit:sandbox_blocked", { command: params[0], reason: sandboxResult.reason, taskId });
            messages.push({
              role: "user",
              content: JSON.stringify({
                tool_name, params,
                output: `${sandboxResult.reason}. This command is not allowed for safety reasons.`,
              }),
            });
            continue;
          }
        }

        // Run PreToolUse hooks
        const hookResult = await hookRunner.preToolUse(tool_name, params, taskId);
        if (hookResult.decision === "block") {
          console.log(`[Step ${stepCount}] BLOCKED by hook: ${hookResult.reason}`);
          eventBus.emitEvent("audit:hook_blocked", { tool_name, reason: hookResult.reason, taskId });
          messages.push({
            role: "user",
            content: JSON.stringify({
              tool_name, params,
              output: `Tool blocked by safety hook: ${hookResult.reason}. Try a different approach.`,
            }),
          });
          continue;
        }

        // Git snapshot - before the first write tool in this task
        if (!gitSnapshotDone && WRITE_TOOLS.has(tool_name)) {
          gitRollback.snapshot(taskId);
          gitSnapshotDone = true;
        }

        if (tools[tool_name]) {
          try {
            const toolStart = Date.now();
            const toolOutput = await Promise.resolve(tools[tool_name](...params));
            const toolElapsed = Date.now() - toolStart;

            const outputStr = typeof toolOutput === "string" ? toolOutput : JSON.stringify(toolOutput);
            const preview = outputStr.slice(0, 300) + (outputStr.length > 300 ? "..." : "");

            console.log(`[Step ${stepCount}] Done in ${toolElapsed}ms`);
            console.log(`[Step ${stepCount}] Output: ${preview}`);

            eventBus.emitEvent("tool:after", {
              tool_name,
              params,
              stepCount,
              taskId,
              duration: toolElapsed,
              outputLength: outputStr.length,
            });

            // Run PostToolUse hooks
            await hookRunner.postToolUse(tool_name, params, outputStr, taskId);

            // Scan output for secrets and redact (double layer: static patterns + dynamic tenant keys)
            const safeOutput = _redactKnownSecrets(secretScanner.redactOutput(outputStr));
            const secretsFound = (outputStr.match(/\[REDACTED\]/g) || []).length - (safeOutput.match(/\[REDACTED\]/g) || []).length;
            if (safeOutput !== outputStr) {
              eventBus.emitEvent("audit:secret_detected", { tool_name, taskId, count: Math.max(1, secretsFound) });
            }

            // Record success for circuit breaker
            circuitBreaker.recordSuccess(taskId);

            messages.push({
              role: "user",
              content: JSON.stringify({ tool_name, params, output: safeOutput }),
            });
          } catch (error) {
            console.log(`[Step ${stepCount}] FAILED: ${error.message}`);

            // Record failure for circuit breaker
            circuitBreaker.recordToolFailure(tool_name);

            eventBus.emitEvent("tool:after", {
              tool_name,
              params,
              stepCount,
              taskId,
              error: error.message,
            });
            messages.push({
              role: "user",
              content: JSON.stringify({
                tool_name,
                params,
                output: `Error executing tool: ${error.message}`,
              }),
            });
          }
        } else {
          console.log(`[Step ${stepCount}] Unknown tool: ${tool_name} - skipping`);
          messages.push({
            role: "user",
            content: JSON.stringify({
              tool_name,
              params,
              output: `Unknown tool: ${tool_name}. Available tools: ${Object.keys(tools).join(", ")}`,
            }),
          });
        }
        continue;
      }

      // --- Final response handling ---
      if (parsedOutput.finalResponse || parsedOutput.type === "text") {
        if (!parsedOutput.text_content) {
          console.log(`[Loop ${loopCount}] Model signaled done but text_content is null - asking for summary`);
          messages.push({
            role: "user",
            content:
              "Provide a text summary of what you did. Set type to 'text', finalResponse to true, and text_content to your summary.",
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
        console.log(
          `Response: "${parsedOutput.text_content.slice(0, 150)}${parsedOutput.text_content.length > 150 ? "..." : ""}"`
        );

        // Add assistant's final response to conversation history
        messages.push({ role: "assistant", content: parsedOutput.text_content });

        const conversationMessages = messages.slice(1);
        return { text: parsedOutput.text_content, messages: conversationMessages, cost };
      }
    } catch (error) {
      // Abort signal fires as an error - exit cleanly
      if (signal?.aborted || error.name === "AbortError") {
        console.log(`[Loop ${loopCount}] Aborted mid-call.`);
        return {
          text: "Agent was stopped by the supervisor.",
          messages: messages.slice(1),
          cost: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, estimatedCost: 0, modelCalls: loopCount, model: resolvedModelId },
        };
      }

      consecutiveErrors++;
      console.log(`[Loop ${loopCount}] Model call failed (${consecutiveErrors}/3): ${error.message}`);

      // Give up after 3 consecutive failures
      if (consecutiveErrors >= 3) {
        console.log(`[FATAL] 3 consecutive model failures. Stopping.`);
        return {
          text: `I encountered an error while processing your request: ${error.message}`,
          messages: messages.slice(1),
          cost: {
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            estimatedCost: 0,
            modelCalls: loopCount,
            model: resolvedModelId,
          },
        };
      }

      // Retry with a user-role nudge (compatible with all providers)
      messages.push({
        role: "user",
        content: `[System: previous call failed: ${error.message}] Please provide your final answer. Set type to "text" and finalResponse to true.`,
      });
      continue;
    }
  }
}
