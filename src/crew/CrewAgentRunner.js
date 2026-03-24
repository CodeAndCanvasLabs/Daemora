import { tool } from "ai";
import { z } from "zod";
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
 * Crew Agent Runner - spawns specialist sub-agents for crew members.
 *
 * Each crew member is a self-contained sub-agent with:
 *   - Crew member's own tools (from CrewRegistry)
 *   - Crew member's profile (systemPrompt, temperature, model from manifest)
 *   - Crew member's skills (local + global skill IDs from manifest)
 *   - Base tools for file I/O, web, etc.
 *   - Persistent session per crew member per main session
 */

// ── System prompt ─────────────────────────────────────────────────────────────

function buildCrewAgentSystemPrompt(member, manifest) {
  const profilePrompt = manifest.profile?.systemPrompt || "";
  const memberDesc = manifest.description || member.name;

  return {
    role: "system",
    content: `You are a specialist crew member: "${member.name}". ${memberDesc}.
${profilePrompt ? `\n${profilePrompt}\n` : ""}
# Rules - You Own This Task

- **Do the work, don't describe it.** Your first response must be a tool_call, not a plan.
- **Chain calls until fully done.** After each tool result, decide: need more tools? Call another. Only set finalResponse true when the task is genuinely complete. Never set finalResponse true with "in progress" or "will follow up" - that is a failure.
- **Never ask for clarification.** You have everything you need in the task description. Make reasonable decisions and proceed.
- **Handle errors yourself.** If a tool call fails, read the error, adjust your approach, try again. Do not give up and report failure unless you have exhausted all approaches.
- **Mid-task user follow-up** → replyToUser() to acknowledge immediately, fold in, keep working.
- **Be thorough.** If the task says "update all tasks in a project", update all of them. If it says "research X", gather enough detail to be useful. Don't do a half job.
- **Use base tools for research.** webSearch and webFetch for gathering data, readFile/writeFile for reading and saving, createDocument for reports. Your specialist tools are for the ${member.name} service specifically.
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
 * @param {string} crewId           - Crew member ID (e.g. "google-services")
 * @param {string} taskDescription - Full task description
 * @param {object} options         - Forwarded to spawnSubAgent
 * @returns {Promise<string>}      - Agent's final response
 */
export async function runCrewAgent(crewId, taskDescription, options = {}) {
  const { mainSessionId, ...restOptions } = options;

  const registry = getRegistry();
  const member = registry.crew.find(p => p.id === crewId);

  if (!member) {
    const available = registry.crew
      .filter(p => p.status === "loaded")
      .map(p => `${p.id} (${p.name})`);
    return `Crew member "${crewId}" not found. Available crew: ${available.join(", ") || "none"}`;
  }

  if (member.status !== "loaded") {
    if (member.status === "needs-config") {
      return `Crew member "${member.name}" needs configuration: ${member.error}. Use the settings UI or CLI to configure.`;
    }
    if (member.status === "disabled") {
      return `Crew member "${member.name}" is disabled. Enable via settings.`;
    }
    return `Crew member "${member.name}" is not available (status: ${member.status}). Error: ${member.error || "unknown"}`;
  }

  // Get crew member's custom tools from registry (may be empty for profile-only crews)
  const crewTools = registry.tools.filter(t => t.crewId === crewId);

  // Build AI SDK tools from crew tool schemas (proper Zod validation)
  const crewAITools = {};
  for (const { name, fn, schema, description } of crewTools) {
    crewAITools[name] = tool({
      description: description || `${name} - crew tool`,
      inputSchema: schema || z.object({}).passthrough(),
      execute: async (params) => {
        console.log(`[CrewAgent:${crewId}] Tool: ${name}`);
        try {
          return await Promise.resolve(fn(params));
        } catch (err) {
          return `Error: ${err.message}`;
        }
      },
    });
  }

  const manifest = member.manifest || {};
  const systemPromptOverride = buildCrewAgentSystemPrompt(member, manifest);
  const skills = _resolveCrewSkills(manifest.skills);
  const model = manifest.profile?.model ?? null;

  // Persistent session: {mainSessionId}--crew:{crewId}
  const subSessionId = mainSessionId ? `${mainSessionId}--crew:${crewId}` : null;
  let historyMessages = [];
  if (subSessionId) {
    const subSession = getSession(subSessionId);
    if (subSession && subSession.messages.length > 0) {
      historyMessages = subSession.messages.map(m => ({ role: m.role, content: m.content }));
      console.log(`[CrewAgent] Loaded ${historyMessages.length} history messages for "${crewId}"`);
    }
  }

  // Use manifest tools list if defined, otherwise fall back to base tools
  const manifestTools = manifest.tools && manifest.tools.length > 0 ? manifest.tools : CREW_BASE_TOOLS;

  console.log(
    `[CrewAgent] Spawning crew member "${member.name}" (${crewTools.length} specialist tools + ${manifestTools.length} base tools)`
  );

  // Spawn sub-agent:
  //   - tools: manifest tools or base tools (resolved from toolFunctions via name list)
  //   - aiToolOverrides: crew custom tools (pre-built AI SDK tools with Zod schemas) - may be empty
  const fullResult = await spawnSubAgent(taskDescription, {
    ...restOptions,
    tools: manifestTools,
    aiToolOverrides: Object.keys(crewAITools).length > 0 ? crewAITools : undefined,
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
  const loaded = registry.crew.filter(p => p.status === "loaded");
  if (loaded.length === 0) return null;

  return loaded.map(p => ({
    id: p.id,
    name: p.name,
    description: p.description || p.name,
    tools: p.toolNames,
  }));
}
