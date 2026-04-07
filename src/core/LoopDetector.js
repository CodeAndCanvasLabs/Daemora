/**
 * LoopDetector - prevents agent from burning tokens in repetitive tool call patterns.
 *
 * Detection strategies:
 * 1. Exact repeat: same tool + same params 3x in a row (existing behavior, moved here)
 * 2. Ping-pong: alternating pattern [A,B,A,B] detected in sliding window of 8
 * 3. Semantic repeat: same tool + same param keys (ignoring values) 4+ times in last 10
 * 4. Polling: same tool called 5+ times in last 10 regardless of params
 *
 * Returns { blocked: false } or { blocked: true, message: "..." }
 */

import eventBus from "./EventBus.js";

const WINDOW_SIZE = 10;
const PING_PONG_WINDOW = 8;

class LoopDetector {
  constructor() {
    // Per-task history to avoid cross-task interference
    this.history = new Map(); // taskId -> Array<{ tool, params, hash }>
  }

  /**
   * Record a tool call and check for loop patterns.
   * @returns {{ blocked: boolean, pattern?: string, message?: string }}
   */
  record(toolName, params, taskId) {
    const key = taskId || "_default";
    if (!this.history.has(key)) this.history.set(key, []);
    const hist = this.history.get(key);

    const paramHash = _hashParams(toolName, params);
    const exact = JSON.stringify({ tool: toolName, params });

    hist.push({ tool: toolName, exact, hash: paramHash });
    if (hist.length > WINDOW_SIZE) hist.shift();

    // 1. Exact repeat (3x same tool + same params in a row)
    if (hist.length >= 3) {
      const last3 = hist.slice(-3);
      if (last3.every(h => h.exact === last3[0].exact)) {
        this._emit(toolName, "exact_repeat", taskId);
        return {
          blocked: true,
          pattern: "exact_repeat",
          message: `Tool "${toolName}" called 3x with identical params. Change your approach — try different parameters, a different tool, or re-read the context.`,
        };
      }
    }

    // 2. Ping-pong (A→B→A→B pattern)
    if (hist.length >= 4) {
      const recent = hist.slice(-PING_PONG_WINDOW);
      const pingPong = _detectPingPong(recent);
      if (pingPong) {
        this._emit(toolName, "ping_pong", taskId);
        return {
          blocked: true,
          pattern: "ping_pong",
          message: `Detected ping-pong loop: ${pingPong}. You're alternating between the same tools without progress. Stop and try a completely different approach.`,
        };
      }
    }

    // 3. Semantic repeat (same tool + same param structure 4+ times)
    if (hist.length >= 4) {
      const hashCount = hist.filter(h => h.hash === paramHash).length;
      if (hashCount >= 4) {
        this._emit(toolName, "semantic_repeat", taskId);
        return {
          blocked: true,
          pattern: "semantic_repeat",
          message: `Tool "${toolName}" called ${hashCount}x with similar params. You're repeating the same pattern. Try a fundamentally different approach.`,
        };
      }
    }

    // 4. Polling (same tool 5+ times in window regardless of params)
    const toolCount = hist.filter(h => h.tool === toolName).length;
    if (toolCount >= 5) {
      this._emit(toolName, "polling", taskId);
      return {
        blocked: true,
        pattern: "polling",
        message: `Tool "${toolName}" called ${toolCount}x in last ${WINDOW_SIZE} steps. If you're polling for a result, stop and report the current status instead.`,
      };
    }

    return { blocked: false };
  }

  /** Clean up task history on completion. */
  cleanup(taskId) {
    this.history.delete(taskId || "_default");
  }

  _emit(toolName, pattern, taskId) {
    eventBus.emitEvent("loop:detected", { toolName, pattern, taskId });
    console.log(`[LoopDetector] ${pattern} detected: ${toolName} (task ${taskId?.slice(0, 8) || "?"})`);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Hash tool name + sorted param keys (ignoring values) for semantic comparison. */
function _hashParams(toolName, params) {
  const keys = params && typeof params === "object" ? Object.keys(params).sort().join(",") : "";
  return `${toolName}:${keys}`;
}

/** Detect ping-pong: check if last N entries form a repeating 2- or 3-element cycle. */
function _detectPingPong(entries) {
  if (entries.length < 4) return null;

  // Check 2-cycle: A,B,A,B
  const last4 = entries.slice(-4).map(e => e.tool);
  if (last4[0] === last4[2] && last4[1] === last4[3] && last4[0] !== last4[1]) {
    return `${last4[0]} ↔ ${last4[1]}`;
  }

  // Check 3-cycle: A,B,C,A,B,C
  if (entries.length >= 6) {
    const last6 = entries.slice(-6).map(e => e.tool);
    if (last6[0] === last6[3] && last6[1] === last6[4] && last6[2] === last6[5] &&
        (last6[0] !== last6[1] || last6[1] !== last6[2])) {
      return `${last6[0]} → ${last6[1]} → ${last6[2]}`;
    }
  }

  return null;
}

const loopDetector = new LoopDetector();
export default loopDetector;
