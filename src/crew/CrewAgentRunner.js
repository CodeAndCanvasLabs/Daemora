import { spawnSubAgent } from "../agents/SubAgentManager.js";
import { getRegistry } from "./PluginRegistry.js";
import { toolFunctions } from "../tools/index.js";
import { createSession, getSession, setMessages } from "../services/sessions.js";
import { compactForSession } from "../utils/msgText.js";
import tenantContext from "../tenants/TenantContext.js";

/**
 * Base tools injected into every crew member alongside their specialist tools.
 */
const CREW_BASE_TOOLS = [
  "readFile", "writeFile", "editFile", "listDirectory",
  "glob", "grep",
  "executeCommand",
  "webFetch", "webSearch",
  "createDocument",
  "replyToUser",
];

/**
 * Crew Agent Runner — spawns specialist sub-agents for plugins (crew members).
 *
 * Each crew member is a self-contained sub-agent with:
 *   - Plugin's own tools (from PluginRegistry)
 *   - Plugin's profile (systemPrompt, temperature, model from manifest)
 *   - Plugin's skills (local + global skill IDs from manifest)
 *   - Base tools for file I/O, web, etc.
 *   - Persistent session per crew member per main session
 */

// ── System prompt ─────────────────────────────────────────────────────────────

function buildCrewAgentSystemPrompt(plugin, manifest) {
  const profilePrompt = manifest.profile?.systemPrompt || "";
  const pluginDesc = manifest.description || plugin.name;

  return {
    role: "system",
    content: `You are a specialist crew member: "${plugin.name}". ${pluginDesc}.
${profilePrompt ? `\n${profilePrompt}\n` : ""}
# Rules - You Own This Task

- **Do the work, don't describe it.** Your first response must be a tool_call, not a plan.
- **Chain calls until fully done.** After each tool result, decide: need more tools? Call another. Only set finalResponse true when the task is genuinely complete. Never set finalResponse true with "in progress" or "will follow up" — that is a failure.
- **Never ask for clarification.** You have everything you need in the task description. Make reasonable decisions and proceed.
- **Handle errors yourself.** If a tool call fails, read the error, adjust your approach, try again. Do not give up and report failure unless you have exhausted all approaches.
- **Mid-task user follow-up** → replyToUser() to acknowledge immediately, fold in, keep working.
- **Be thorough.** If the task says "update all tasks in a project", update all of them. If it says "research X", gather enough detail to be useful. Don't do a half job.
- **Use base tools for research.** webSearch and webFetch for gathering data, readFile/writeFile for reading and saving, createDocument for reports. Your specialist tools are for the ${plugin.name} service specifically.
- **End with a concise summary if its related to search or something return details in summary not too concise as well in proper format.** When done, set finalResponse true. Write 1-3 sentences: what was done and key outcomes. Never dump raw API responses, full JSON payloads, message IDs, status codes, or technical artifacts. The main agent will relay your response to the user.`,
  };
}

// ── Skill resolution ──────────────────────────────────────────────────────────

function _resolveCrewSkills(skillIds) {
  if (!skillIds || !Array.isArray(skillIds) || skillIds.length === 0) return null;
  return skillIds;
}

// ── Main runner ───────────────────────────────────────────────────────────────

/**
 * Run a specialist crew member agent.
 *
 * @param {string} pluginId        - Plugin/crew member ID (e.g. "google-services")
 * @param {string} taskDescription - Full task description
 * @param {object} options         - Forwarded to spawnSubAgent
 * @returns {Promise<string>}      - Agent's final response
 */
export async function runCrewAgent(pluginId, taskDescription, options = {}) {
  const { mainSessionId, ...restOptions } = options;

  const registry = getRegistry();
  const plugin = registry.plugins.find(p => p.id === pluginId);

  if (!plugin) {
    const available = registry.plugins
      .filter(p => p.status === "loaded")
      .map(p => `${p.id} (${p.name})`);
    return `Crew member "${pluginId}" not found. Available crew: ${available.join(", ") || "none"}`;
  }

  if (plugin.status !== "loaded") {
    if (plugin.status === "needs-config") {
      return `Crew member "${plugin.name}" needs configuration: ${plugin.error}. Use the settings UI or CLI to configure.`;
    }
    if (plugin.status === "disabled") {
      return `Crew member "${plugin.name}" is disabled. Enable via settings.`;
    }
    return `Crew member "${plugin.name}" is not available (status: ${plugin.status}). Error: ${plugin.error || "unknown"}`;
  }

  // Get crew member's tools from registry
  const crewTools = registry.tools.filter(t => t.pluginId === pluginId);
  if (crewTools.length === 0) {
    return `Crew member "${plugin.name}" has no tools registered.`;
  }

  // Build tool override: crew tools + base tools
  const agentTools = {};
  for (const name of CREW_BASE_TOOLS) {
    if (toolFunctions[name]) agentTools[name] = toolFunctions[name];
  }
  for (const { name, fn } of crewTools) {
    agentTools[name] = fn;
  }

  const manifest = plugin.manifest || {};
  const systemPromptOverride = buildCrewAgentSystemPrompt(plugin, manifest);
  const skills = _resolveCrewSkills(manifest.skills);
  const model = manifest.profile?.model ?? null;

  // Persistent session: {mainSessionId}--crew:{pluginId}
  const subSessionId = mainSessionId ? `${mainSessionId}--crew:${pluginId}` : null;
  let historyMessages = [];
  if (subSessionId) {
    const subSession = getSession(subSessionId);
    if (subSession && subSession.messages.length > 0) {
      historyMessages = subSession.messages.map(m => ({ role: m.role, content: m.content }));
      console.log(`[CrewAgent] Loaded ${historyMessages.length} history messages for "${pluginId}"`);
    }
  }

  console.log(
    `[CrewAgent] Spawning crew member "${plugin.name}" (${crewTools.length} specialist tools + ${CREW_BASE_TOOLS.length} base tools)`
  );

  const fullResult = await spawnSubAgent(taskDescription, {
    ...restOptions,
    toolOverride: agentTools,
    systemPromptOverride,
    skills,
    model,
    depth: 1,
    historyMessages,
    returnFullResult: true,
  });

  // Save sub-agent session (cap at 100 messages)
  if (subSessionId && fullResult.messages) {
    let subSession = getSession(subSessionId);
    if (!subSession) subSession = createSession(subSessionId);
    const capped = fullResult.messages.length > 100
      ? fullResult.messages.slice(-100)
      : fullResult.messages;
    setMessages(subSessionId, compactForSession(capped));
    console.log(`[CrewAgent] Saved ${capped.length} messages to sub-session "${subSessionId}"`);
  }

  return typeof fullResult === "string" ? fullResult : fullResult.text;
}

/**
 * Get summary of available crew members for the main agent's context.
 */
export function getCrewSummaries() {
  const registry = getRegistry();
  const loaded = registry.plugins.filter(p => p.status === "loaded" && p.toolNames.length > 0);
  if (loaded.length === 0) return null;

  return loaded.map(p => ({
    id: p.id,
    name: p.name,
    description: p.description || p.name,
    tools: p.toolNames,
  }));
}
