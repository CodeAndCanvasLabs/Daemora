import { runCrewAgent } from "../crew/CrewAgentRunner.js";
import tenantContext from "../tenants/TenantContext.js";

/**
 * useCrew - delegate a task to a specialist crew member.
 *
 * Each crew member is a self-contained sub-agent with its own tools, profile, and skills.
 * The specialist has persistent session context across calls within the same session.
 *
 * @param {object} params - { crewId, taskDescription }
 * @returns {Promise<string>} - Crew member's final response
 */
export async function useCrew(params) {
  const crewId = params?.crewId;
  const taskDescription = params?.taskDescription;

  if (!crewId) return "crewId is required.";
  if (!taskDescription) return "taskDescription is required.";

  const store = tenantContext.getStore();
  const mainSessionId = store?.sessionId || null;
  const parentTaskId = store?.currentTaskId || null;

  return runCrewAgent(crewId, taskDescription, { mainSessionId, parentTaskId });
}
