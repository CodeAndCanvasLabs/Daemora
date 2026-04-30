/**
 * LoopDetector — prevents the agent from burning tokens in repetitive
 * tool call patterns. Ported from hermes tools/file_tools.py + daemora-js
 * core/LoopDetector.js with four detection strategies:
 *
 *   1. Exact repeat: same tool + same params 3x in a row
 *   2. Ping-pong: alternating A→B→A→B within a rolling window of 8
 *   3. Semantic repeat: same tool + same param keys (ignoring values) 4+
 *      times in the last 10 calls
 *   4. Polling: same tool 8+ times in the last 10 regardless of params
 *
 * On block: returns a structured message the wrapper turns into a
 * tool-error, so the model sees the error and gets a chance to change
 * course. Cleanup is explicit — the TaskRunner calls `cleanup(taskId)`
 * once the task ends.
 *
 * Wiring: see `wrapWithLoopDetection` in AgentLoop.
 */

import type { EventBus } from "../events/eventBus.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("core.loop_detector");

const WINDOW_SIZE = 10;
const PING_PONG_WINDOW = 8;

/** Tools where different param VALUES mean genuinely different operations. */
const VALUE_SENSITIVE_TOOLS: ReadonlySet<string> = new Set([
  "read_file", "write_file", "edit_file", "apply_patch", "list_directory",
  "glob", "grep",
  "execute_command", "web_fetch", "web_search", "fetch_url",
  "use_crew", "parallel_crew", "use_mcp",
  "image_analysis", "image_ops", "generate_image", "generate_music", "generate_video",
  "skill_view", "skill_manage",
  "memory", "memory_save", "memory_recall", "session_search",
  // Agent-management tools — every call has a distinct action/name/task
  // payload, so identical-key/distinct-value calls (e.g. 4 cron adds with
  // different schedules) must NOT trigger semantic_repeat.
  "cron", "goal", "watcher", "manage_mcp", "manage_agents", "poll", "reload",
]);

export type LoopPattern = "exact_repeat" | "ping_pong" | "semantic_repeat" | "polling";

export interface LoopCheckResult {
  readonly blocked: boolean;
  readonly pattern?: LoopPattern;
  readonly message?: string;
}

interface HistoryEntry {
  readonly tool: string;
  readonly exact: string;
  readonly hash: string;
}

export class LoopDetector {
  private readonly history = new Map<string, HistoryEntry[]>();

  constructor(private readonly bus?: EventBus) {}

  /** Record a tool call and check for loop patterns. */
  record(toolName: string, params: unknown, taskId: string): LoopCheckResult {
    const key = taskId || "_default";
    let hist = this.history.get(key);
    if (!hist) { hist = []; this.history.set(key, hist); }

    const paramHash = hashParams(toolName, params);
    const exact = safeJson({ tool: toolName, params });
    hist.push({ tool: toolName, exact, hash: paramHash });
    if (hist.length > WINDOW_SIZE) hist.shift();

    // 1. Exact repeat
    if (hist.length >= 3) {
      const last3 = hist.slice(-3);
      if (last3.every((h) => h.exact === last3[0]!.exact)) {
        return this.block(toolName, taskId, "exact_repeat",
          `Tool "${toolName}" called 3× with identical params. Change your approach — try different parameters, a different tool, or re-read the context.`);
      }
    }

    // 2. Ping-pong (A↔B or A→B→C→A→B→C)
    if (hist.length >= 4) {
      const recent = hist.slice(-PING_PONG_WINDOW);
      const pp = detectPingPong(recent);
      if (pp) {
        const last4 = recent.slice(-4);
        const toolsInPair = new Set(last4.map((h) => h.tool));
        const allValueSensitive = [...toolsInPair].every((t) => VALUE_SENSITIVE_TOOLS.has(t));
        const hasDistinctParams = new Set(last4.map((h) => h.hash)).size > 2;
        // Different params each time on value-sensitive tools = legit verify-fix cycle
        if (!(allValueSensitive && hasDistinctParams)) {
          return this.block(toolName, taskId, "ping_pong",
            `Detected ping-pong loop: ${pp}. You're alternating between the same tools without progress. Stop and try a completely different approach.`);
        }
      }
    }

    // 3. Semantic repeat
    if (hist.length >= 4) {
      const hashCount = hist.filter((h) => h.hash === paramHash).length;
      if (hashCount >= 4) {
        return this.block(toolName, taskId, "semantic_repeat",
          `Tool "${toolName}" called ${hashCount}× with similar params. You're repeating the same pattern. Try a fundamentally different approach.`);
      }
    }

    // 4. Polling (high threshold — read/execute are legitimately frequent)
    const toolCount = hist.filter((h) => h.tool === toolName).length;
    if (toolCount >= 8) {
      return this.block(toolName, taskId, "polling",
        `Tool "${toolName}" called ${toolCount}× in the last ${WINDOW_SIZE} steps. If polling for a result, stop and report the current status instead.`);
    }

    return { blocked: false };
  }

  /** Drop task history once the task ends — prevents memory growth. */
  cleanup(taskId: string): void {
    this.history.delete(taskId || "_default");
  }

  private block(toolName: string, taskId: string, pattern: LoopPattern, message: string): LoopCheckResult {
    log.info({ taskId: taskId.slice(0, 8), tool: toolName, pattern }, "loop detected");
    this.bus?.emit("loop:detected", { taskId, toolName, pattern, message });
    return { blocked: true, pattern, message };
  }
}

function hashParams(toolName: string, params: unknown): string {
  if (!params || typeof params !== "object") return `${toolName}:`;
  const p = params as Record<string, unknown>;
  if (VALUE_SENSITIVE_TOOLS.has(toolName)) {
    const sorted = Object.keys(p).sort()
      .map((k) => `${k}=${String(p[k]).slice(0, 80)}`)
      .join(",");
    return `${toolName}:${sorted}`;
  }
  const keys = Object.keys(p).sort().join(",");
  return `${toolName}:${keys}`;
}

function detectPingPong(entries: readonly HistoryEntry[]): string | null {
  if (entries.length < 4) return null;
  const last4 = entries.slice(-4).map((e) => e.tool);
  if (last4[0] === last4[2] && last4[1] === last4[3] && last4[0] !== last4[1]) {
    return `${last4[0]} ↔ ${last4[1]}`;
  }
  if (entries.length >= 6) {
    const last6 = entries.slice(-6).map((e) => e.tool);
    if (last6[0] === last6[3] && last6[1] === last6[4] && last6[2] === last6[5]
        && (last6[0] !== last6[1] || last6[1] !== last6[2])) {
      return `${last6[0]} → ${last6[1]} → ${last6[2]}`;
    }
  }
  return null;
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v) ?? ""; } catch { return String(v); }
}
