/**
 * manageAgents(action, paramsJson?) - List, kill, or steer running sub-agents.
 * Inspired by OpenClaw's subagents tool.
 */
import {
  listActiveAgents,
  killAgent,
  steerAgent,
} from "../agents/SubAgentManager.js";

export function manageAgents(action, paramsJson) {
  try {
    const params = paramsJson ? JSON.parse(paramsJson) : {};

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

      default:
        return `Unknown action: "${action}". Available: list, kill, steer`;
    }
  } catch (error) {
    return `Error managing agents: ${error.message}`;
  }
}

export const manageAgentsDescription =
  'manageAgents(action: string, paramsJson?: string) - Manage running sub-agents. Actions: "list" (show all), "kill" ({"agentId":"id"}), "steer" ({"agentId":"id","message":"new instruction"}).';
