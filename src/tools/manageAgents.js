/**
 * manageAgents(action, paramsJson?) - List, kill, or steer running sub-agents + manage persistent sessions.
 */
import {
  listActiveAgents,
  killAgent,
  steerAgent,
} from "../agents/SubAgentManager.js";
import { listSessions, getSession, clearSession } from "../services/sessions.js";
import tenantContext from "../tenants/TenantContext.js";
import { msgText } from "../utils/msgText.js";
import { mergeLegacyParams as _mergeLegacy } from "../utils/mergeToolParams.js";

export function manageAgents(toolParams) {
  const action = toolParams?.action;
  try {
    const params = _mergeLegacy(toolParams);

    switch (action) {
      case "list": {
        const agents = listActiveAgents();
        if (agents.length === 0) return "No active sub-agents running.";
        const lines = agents.map(
          (a) => `• ${a.id} - "${a.task}" (running ${Math.round(a.elapsedMs / 1000)}s)`
        );
        return `Active sub-agents (${agents.length}):\n${lines.join("\n")}`;
      }

      case "kill": {
        if (!params.agentId) return 'Error: agentId is required for "kill" action';
        const result = killAgent(params.agentId);
        return result;
      }

      case "steer": {
        if (!params.agentId) return 'Error: agentId is required for "steer" action';
        if (!params.message) return 'Error: message is required for "steer" action';
        const result = steerAgent(params.agentId, params.message);
        return result;
      }

      // ── Persistent sub-agent session management ──────────────────────────
      case "sessions": {
        const store = tenantContext.getStore();
        const mainSessionId = store?.sessionId;
        if (!mainSessionId) return "No active session context.";

        const subSessions = listSessions(mainSessionId);
        if (subSessions.length === 0) return "No sub-agent sessions found.";

        const lines = subSessions.map(id => {
          const label = id.slice(mainSessionId.length + 2); // strip "telegram-123--"
          const session = getSession(id);
          const msgCount = session?.messages?.length || 0;
          return `• ${label} (${msgCount} messages) — sessionId: "${id}"`;
        });
        return `Sub-agent sessions (${subSessions.length}):\n${lines.join("\n")}`;
      }

      case "session_get": {
        if (!params.sessionId) return 'Error: sessionId is required for "session_get" action';
        const session = getSession(params.sessionId);
        if (!session) return `Session "${params.sessionId}" not found.`;
        const count = params.count || 5;
        const last = session.messages.slice(-count);
        if (last.length === 0) return "Session exists but has no messages.";
        return `Last ${last.length} messages from "${params.sessionId}":\n\n` +
          last.map(m => `[${m.role}]: ${msgText(m.content).slice(0, 300)}`).join("\n\n");
      }

      case "session_clear": {
        if (!params.sessionId) return 'Error: sessionId is required for "session_clear" action';
        const cleared = clearSession(params.sessionId);
        return cleared
          ? `Session "${params.sessionId}" cleared.`
          : `Session "${params.sessionId}" not found.`;
      }

      case "session_clear_all": {
        const store = tenantContext.getStore();
        const mainSessionId = store?.sessionId;
        if (!mainSessionId) return "No active session context.";
        const subSessions = listSessions(mainSessionId);
        if (subSessions.length === 0) return "No sub-agent sessions to clear.";
        subSessions.forEach(id => clearSession(id));
        return `Cleared ${subSessions.length} sub-agent session(s).`;
      }

      default:
        return `Unknown action: "${action}". Available: list, kill, steer, sessions, session_get, session_clear, session_clear_all`;
    }
  } catch (error) {
    return `Error managing agents: ${error.message}`;
  }
}

export const manageAgentsDescription =
  'manageAgents(action: string, paramsJson?: string) - Manage sub-agents and their persistent sessions. ' +
  'Actions: "list" (running agents), "kill" ({"agentId":"id"}), "steer" ({"agentId":"id","message":"..."}), ' +
  '"sessions" (list persistent sub-agent sessions), "session_get" ({"sessionId":"id","count":5} - last N messages), ' +
  '"session_clear" ({"sessionId":"id"} - reset a specialist), "session_clear_all" (clear all sub-agent sessions).';
