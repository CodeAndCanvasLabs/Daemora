import eventBus from "../core/EventBus.js";
import { run } from "../storage/Database.js";

/**
 * Audit Log - append-only logging of all agent actions.
 *
 * Writes to: SQLite audit_log table
 *
 * Listens to EventBus events already emitted by AgentLoop, Supervisor,
 * SubAgentManager, and TaskRunner. No changes needed to other files -
 * just start() this and it captures everything automatically.
 */

class AuditLog {
  constructor() {
    this.enabled = true;
    this.entryCount = 0;
  }

  start() {
    // ── Tool lifecycle (emitted by AgentLoop) ─────────────────────────────
    eventBus.on("tool:before", ({ tool_name, params, taskId, stepCount }) => {
      this.write({ event: "tool_attempted", tool_name, taskId, stepCount,
        params: typeof params === "object" ? JSON.stringify(params).slice(0, 360) : String(params).slice(0, 360) });
    });

    eventBus.on("tool:after", ({ tool_name, taskId, stepCount, duration, outputLength, error }) => {
      if (error) {
        this.write({ event: "tool_failed", tool_name, taskId, stepCount, duration, error });
      } else {
        this.write({ event: "tool_executed", tool_name, taskId, stepCount, duration, outputLength });
      }
    });

    // ── Model calls (emitted by AgentLoop) ───────────────────────────────
    eventBus.on("model:called", ({ modelId, loopCount, elapsed, inputTokens, outputTokens, taskId }) => {
      this.write({ event: "model_called", modelId, loopCount, elapsed, inputTokens, outputTokens, taskId });
    });

    // ── Agent lifecycle (emitted by SubAgentManager) ─────────────────────
    eventBus.on("agent:spawned", ({ agentId, taskDescription, depth, parentTaskId }) => {
      this.write({ event: "agent_spawned", agentId, depth, parentTaskId,
        task: taskDescription?.slice(0, 120) });
    });

    eventBus.on("agent:killed", ({ agentId, reason }) => {
      this.write({ event: "agent_killed", agentId, reason });
    });

    // ── Safety events (emitted by PermissionGuard, Sandbox, HumanApproval, AgentLoop) ──
    eventBus.on("audit:permission_denied", ({ tool_name, reason, taskId }) => {
      this.write({ event: "permission_denied", tool_name, reason, taskId });
    });

    eventBus.on("audit:sandbox_blocked", ({ command, reason, taskId }) => {
      this.write({ event: "sandbox_blocked", command: command?.slice(0, 200), reason, taskId });
    });

    eventBus.on("audit:hook_blocked", ({ tool_name, reason, taskId }) => {
      this.write({ event: "hook_blocked", tool_name, reason, taskId });
    });

    eventBus.on("audit:secret_detected", ({ tool_name, taskId, count }) => {
      this.write({ event: "secret_detected", tool_name, taskId, count });
    });

    eventBus.on("audit:approval_requested", ({ requestId, tool_name, taskId, channelMeta }) => {
      this.write({ event: "approval_requested", requestId, tool_name, taskId,
        channel: channelMeta?.channel });
    });

    eventBus.on("audit:approval_result", ({ requestId, tool_name, taskId, approved, source }) => {
      this.write({ event: "approval_result", requestId, tool_name, taskId, approved, source });
    });

    eventBus.on("audit:git_snapshot", ({ taskId, ref }) => {
      this.write({ event: "git_snapshot", taskId, ref });
    });

    eventBus.on("audit:git_rollback", ({ taskId, ref, success }) => {
      this.write({ event: "git_rollback", taskId, ref, success });
    });

    eventBus.on("audit:memory_written", ({ category, entryLength, taskId }) => {
      this.write({ event: "memory_written", category, entryLength, taskId });
    });

    // ── Supervisor (emitted by Supervisor) ───────────────────────────────
    eventBus.on("supervisor:warning", (data) => {
      this.write({ event: "supervisor_warning", ...data });
    });

    eventBus.on("supervisor:alert", (data) => {
      this.write({ event: "supervisor_alert", ...data });
    });

    eventBus.on("supervisor:kill", ({ taskId, reason }) => {
      this.write({ event: "supervisor_kill", taskId, reason });
    });

    // ── Manual audit events (catch-all for anything else) ────────────────
    eventBus.on("audit:event", (data) => {
      if (!this.enabled) return;
      this.write(data);
    });

    console.log(`[AuditLog] Started - logging to SQLite`);
  }

  write(data) {
    if (!this.enabled) return;
    try {
      const { event, ...rest } = data;
      run(
        "INSERT INTO audit_log (tenant_id, event, data, created_at) VALUES ($tid, $event, $data, $ts)",
        {
          $tid: null,
          $event: event || "unknown",
          $data: Object.keys(rest).length > 0 ? JSON.stringify(rest) : null,
          $ts: new Date().toISOString(),
        }
      );
      this.entryCount++;
    } catch (error) {
      // Never let audit failures crash the system
      console.log(`[AuditLog] Write error: ${error.message}`);
    }
  }

  stats() {
    return { enabled: this.enabled, entriesWritten: this.entryCount };
  }
}

const auditLog = new AuditLog();
export default auditLog;
