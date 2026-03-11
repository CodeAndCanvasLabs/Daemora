import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { config } from "../config/default.js";
import skillLoader from "../skills/SkillLoader.js";
import mcpManager from "../mcp/MCPManager.js";
import tenantContext from "../tenants/TenantContext.js";
import { queryAll } from "../storage/Database.js";

// ── Tool → required env keys mapping ──────────────────────────────────────────
const TOOL_REQUIRED_KEYS = {
  sendEmail:       ["RESEND_API_KEY", "EMAIL_USER"],
  makeVoiceCall:   ["TWILIO_ACCOUNT_SID"],
  transcribeAudio: ["OPENAI_API_KEY"],
  textToSpeech:    ["OPENAI_API_KEY", "ELEVENLABS_API_KEY"],
  generateImage:   ["OPENAI_API_KEY"],
  googlePlaces:    ["GOOGLE_PLACES_API_KEY"],
  calendar:        ["GOOGLE_CALENDAR_API_KEY"],
  contacts:        ["GOOGLE_CONTACTS_ACCESS_TOKEN"],
  philipsHue:      ["HUE_BRIDGE_IP"],
  sonos:           ["SONOS_HOST"],
  database:        ["DATABASE_URL", "MYSQL_URL"],
  sshTool:         ["SSH_DEFAULT_HOST"],
};

function _getConfiguredKeys() {
  const store = tenantContext.getStore();
  const tenantKeys = store?.apiKeys || {};
  return { ...process.env, ...tenantKeys };
}

function _isToolConfigured(toolName) {
  const requiredKeys = TOOL_REQUIRED_KEYS[toolName];
  if (!requiredKeys) return true;
  const env = _getConfiguredKeys();
  return requiredKeys.some(key => !!env[key]);
}

/**
 * Build system prompt by composing modular sections.
 * @param {string} taskInput - Optional task input for skill matching
 * @param {"full"|"minimal"} promptMode - "full" for main agent, "minimal" for sub-agents
 * @param {object} [runtimeMeta] - { model, agentId, thinkingLevel, taskDescription }
 */
export async function buildSystemPrompt(taskInput, promptMode = "full", runtimeMeta = {}) {
  const isSubAgent = promptMode === "minimal";
  const sections = isSubAgent
    ? await Promise.all([
        renderSoul(true),
        renderResponseFormat(),
        renderToolList(true),
        renderMCPTools(),
        renderSkills(taskInput, 20, true),
        renderMemory(),
        renderSubagentContext(runtimeMeta.profile),
      ])
    : await Promise.all([
        renderSoul(false),
        renderUserProfile(),
        renderResponseFormat(),
        renderToolList(false),
        renderMCPTools(),
        renderToolUsageRules(),
        renderSkills(taskInput),
        renderMemory(),
        renderSemanticRecall(taskInput),
        renderDailyLog(),
      ]);

  const runtime = renderRuntime(runtimeMeta);
  if (runtime) sections.push(runtime);

  return {
    role: "system",
    content: sections.filter(Boolean).join("\n\n---\n\n"),
  };
}

// ── Tenant-aware path resolution ─────────────────────────────────────────────

function _getContextMemoryPaths() {
  const store = tenantContext.getStore();
  const tenantId = store?.tenant?.id;
  if (tenantId) {
    const safeId = tenantId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const tenantDir = join(config.dataDir, "tenants", safeId);
    return { memoryPath: join(tenantDir, "MEMORY.md"), memoryDir: join(tenantDir, "memory"), tenantId };
  }
  return { memoryPath: config.memoryPath, memoryDir: config.memoryDir, tenantId: null };
}

async function renderSemanticRecall(taskInput) {
  if (!taskInput || taskInput.length < 10) return null;
  try {
    const { getRelevantMemories } = await import("../tools/memory.js");
    const { tenantId } = _getContextMemoryPaths();
    return await getRelevantMemories(taskInput, 5, tenantId);
  } catch {
    return null;
  }
}

// ── Section Renderers ────────────────────────────────────────────────────────

function renderSoul(isSubAgent = false) {
  if (existsSync(config.soulPath)) {
    let content = readFileSync(config.soulPath, "utf-8").trim();
    if (isSubAgent) {
      content = content.replace(
        /## Multi-Agent Orchestration[\s\S]*?(?=\n## |\n---|\n$)/,
        ""
      );
    }
    return content;
  }
  return "You are Daemora, a personal helpful AI assistant. Execute tasks immediately using tools.";
}

function renderUserProfile() {
  const store = tenantContext.getStore();
  const tenantId = store?.tenant?.id;
  let profilePath;
  if (tenantId) {
    const safeId = tenantId.replace(/[^a-zA-Z0-9_-]/g, "_");
    profilePath = join(config.dataDir, "tenants", safeId, "user-profile.json");
  } else {
    profilePath = join(config.dataDir, "user-profile.json");
  }
  if (!existsSync(profilePath)) return null;
  try {
    const profile = JSON.parse(readFileSync(profilePath, "utf-8"));
    const lines = [];
    if (profile.name) lines.push(`Name: ${profile.name}`);
    if (profile.personality) lines.push(`Personality: ${profile.personality}`);
    if (profile.tone) lines.push(`Tone: ${profile.tone}`);
    if (profile.instructions) lines.push(`\nCustom Instructions:\n${profile.instructions}`);
    if (lines.length === 0) return null;
    return `# User Profile\n\n${lines.join("\n")}`;
  } catch {
    return null;
  }
}

function renderResponseFormat() {
  const store = tenantContext.getStore();
  const channel = store?.channelMeta?.channel || "http";
  const richChannels = new Set(["http", "discord"]);
  const isRich = richChannels.has(channel);

  return `# Response Rules

- Use tools to take action. Respond with text only when the task is done or you need user input.
- Mid-task user follow-ups → acknowledge via replyToUser(), fold in, keep working.
- ${isRich ? "Markdown supported." : `Plain text only (${channel} — no markdown headers, bold, tables, code blocks).`}
- Be concise. Lead with the answer. 1-3 sentences for final responses.`;
}

function renderToolList(isSubAgent = false) {
  // Unconfigured tools warning
  const unconfigured = Object.keys(TOOL_REQUIRED_KEYS).filter(t => !_isToolConfigured(t));
  if (unconfigured.length === 0) return null;
  return `Unconfigured tools (do NOT call): ${unconfigured.join(", ")}`;
}

function renderMCPTools() {
  const servers = mcpManager.getConnectedServersInfo();
  if (servers.length === 0) return "";

  const serverList = servers
    .map((s) => {
      const desc = s.description ? ` — ${s.description}` : "";
      return `- **${s.name}**${desc} (${s.toolCount} tools)`;
    })
    .join("\n");

  return `# MCP Servers

Use useMCP(serverName, taskDescription) to delegate. Prefer MCP over built-in tools when both apply.

${serverList}`;
}

function renderToolUsageRules() {
  return `# Tool Rules

- Read before editing. Never edit blind.
- Small change → editFile. Full rewrite → writeFile.
- editFile oldString not found → re-read, retry with exact content.
- Same params fail twice → stop, diagnose, try different approach.
- \`<conversation-summary>\` = compacted history — treat as ground truth, don't redo.`;
}

async function renderSkills(taskInput, limit = 20, isSubAgent = false) {
  const totalCount = skillLoader.list().length;
  if (totalCount === 0) return "";

  const summaries = await skillLoader.getMatchedSkillSummaries(taskInput, limit);
  if (!summaries || summaries.length === 0) return "";

  const lines = summaries.map(s =>
    `- ${s.name} (${s.path}) — ${s.description}`
  );
  const remaining = totalCount - summaries.length;
  const dirHint = remaining > 0
    ? `\n\n${totalCount} skills total in ${config.skillsDir}.`
    : "";

  const preamble = isSubAgent
    ? `If a skill applies → readFile its path, follow it. Skip "confirm with user" steps.`
    : `Scan this list. If a skill applies, readFile its path to load it, then follow it.
- Planning required (3+ steps, unclear scope, multi-file) → load planning skill first.
- Multi-agent task → load orchestration skill first.`;

  return `# Skills

${preamble}

${lines.join("\n")}${dirHint}`;
}

function renderMemory() {
  const { tenantId } = _getContextMemoryPaths();
  let rows;
  if (tenantId) {
    rows = queryAll(
      "SELECT content, category, timestamp FROM memory_entries WHERE tenant_id = $tid ORDER BY id ASC",
      { $tid: tenantId }
    );
  } else {
    rows = queryAll(
      "SELECT content, category, timestamp FROM memory_entries WHERE tenant_id IS NULL ORDER BY id ASC"
    );
  }
  if (rows.length === 0) return "";
  const memory = rows.map(r => {
    const catTag = r.category && r.category !== "general" ? ` [CATEGORY:${r.category}]` : "";
    return `<!-- [${r.timestamp || r.created_at}]${catTag} ${r.content} -->`;
  }).join("\n");
  return `# Agent Memory\n\n${memory}`;
}

function renderDailyLog() {
  const { tenantId } = _getContextMemoryPaths();
  const today = new Date().toISOString().split("T")[0];
  let rows;
  if (tenantId) {
    rows = queryAll(
      "SELECT entry FROM daily_logs WHERE tenant_id = $tid AND date = $date ORDER BY id ASC",
      { $tid: tenantId, $date: today }
    );
  } else {
    rows = queryAll(
      "SELECT entry FROM daily_logs WHERE tenant_id IS NULL AND date = $date ORDER BY id ASC",
      { $date: today }
    );
  }
  if (rows.length === 0) return "";
  const dailyLog = rows.map(r => `- ${r.entry}`).join("\n");
  return `# Today's Log (${today})\n\n${dailyLog}`;
}

const _PROFILE_IDENTITY = {
  coder:      "You are a Senior Software Engineer. You build, fix, and ship — end to end. You write clean code, run tests, verify output, and fix failures without asking.",
  researcher: "You are a Senior Research Analyst. You gather, synthesize, and deliver structured findings. You search deeply, cross-reference sources, and produce clear, actionable reports.",
  writer:     "You are a Senior Content Strategist. You produce polished, audience-aware content. You research before writing, match tone to context, and deliver final output — not drafts.",
  analyst:    "You are a Senior Data Analyst. You process data, run scripts, extract insights, and produce findings with evidence. You deliver conclusions, not raw numbers.",
};

function renderSubagentContext(profile = null) {
  const identity = _PROFILE_IDENTITY[profile] || "You are a specialist agent. You execute assigned tasks with full autonomy.";

  return `# You are a specialist agent

${identity}

**You were delegated a task. Own it. Complete it. No user. No confirmation.**

**If a skill applies, load and follow it.** Skills are domain-specific instructions — use them when they match.

**Act, don't narrate.** Use tools to do the work. Chain calls until the task is genuinely done — not just attempted.

**Figure it out.** If something fails, read the error, adjust, try again. Exhaust your options before giving up.

**Parallel when it makes sense.** Independent actions don't need to wait for each other.

Read before editing. Verify after changes. Save verbose output to files. Return a brief summary of what was done.`;
}

function renderRuntime(meta = {}) {
  const now = new Date();
  const date = now.toISOString().split("T")[0];
  const time = now.toTimeString().split(" ")[0];
  const parts = [];
  if (meta.model) parts.push(`Model: ${meta.model}`);
  if (meta.thinkingLevel) parts.push(`Thinking: ${meta.thinkingLevel}`);
  if (meta.agentId) parts.push(`Agent: ${meta.agentId}`);
  return `# Environment

- Date: ${date} ${time}
- OS: ${process.platform}/${process.arch}
- CWD: ${process.cwd()}
${parts.length > 0 ? parts.map(p => `- ${p}`).join("\n") + "\n" : ""}`;
}

export const systemPrompt = { role: "system", content: "" };
