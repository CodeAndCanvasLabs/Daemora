import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { config } from "../config/default.js";
import skillLoader from "../skills/SkillLoader.js";
import mcpManager from "../mcp/MCPManager.js";
import tenantContext from "../tenants/TenantContext.js";

skillLoader.load();
skillLoader.embedSkills().catch(() => {});

// ── Tool → required env keys mapping ──────────────────────────────────────────
// Tools listed here need at least ONE of their required keys set.
// Unconfigured tools are excluded from full docs and listed as [NO AUTH].
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
 * Build the system prompt dynamically by composing modular sections.
 * @param {string} taskInput - Optional task input for skill matching
 * @param {"full"|"minimal"} promptMode - "full" for main agent, "minimal" for sub-agents
 * @param {object} [runtimeMeta] - Optional metadata for runtime line { model, agentId, thinkingLevel }
 */
export async function buildSystemPrompt(taskInput, promptMode = "full", runtimeMeta = {}) {
  const sections = promptMode === "minimal"
    ? await Promise.all([
        renderSoul(),
        renderUserProfile(),
        renderResponseFormat(),
        renderToolDocs(),
        renderMCPTools(),
        renderToolUsageRules(),
        renderSkills(taskInput, 10),
        renderSubagentContext(runtimeMeta.taskDescription || taskInput),
      ])
    : await Promise.all([
        renderSoul(),
        renderUserProfile(),
        renderResponseFormat(),
        renderToolDocs(),
        renderMCPTools(),
        renderToolUsageRules(),
        renderSkills(taskInput),
        renderMemory(),
        renderSemanticRecall(taskInput),
        renderDailyLog(),
        renderOperationalGuidelines(),
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

function renderSoul() {
  if (existsSync(config.soulPath)) {
    return readFileSync(config.soulPath, "utf-8").trim();
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
  return `# Response Format

You MUST respond with a JSON object matching this exact schema on every turn:

\`\`\`
{
  "type": "tool_call" | "text",
  "tool_call": { "tool_name": "string", "params": ["string", ...] } | null,
  "text_content": "string" | null,
  "finalResponse": boolean
}
\`\`\`

## Rules for each response type:

### When you need to use a tool (type = "tool_call"):
- Set type to "tool_call"
- Set tool_call.tool_name to the tool name
- Set tool_call.params to an array of STRING arguments (even numbers must be strings)
- Set text_content to null
- Set finalResponse to false
- You will receive the tool result in the next message, then continue

### When you are truly finished (type = "text"):
- Set type to "text"
- Set text_content to a brief summary of what you DID (past tense)
- Set tool_call to null
- Set finalResponse to true

## CRITICAL RULES:
1. NEVER set finalResponse to true unless the work is VERIFIED complete - not just written, but confirmed working.
2. If the user asks you to DO something (fix, create, edit, build, search, etc.), your FIRST response MUST be type "tool_call". Not text. Not a plan. A tool call.
3. Chain multiple tool calls across turns. After each tool result, decide: need more tools? Call another. Done with verification? Set finalResponse true.
4. If a tool fails, try an alternative approach. Do NOT give up and ask the user to do it manually.
5. After writing or editing any file, ALWAYS read it back to verify the content is correct before moving on.
6. After any coding task, run the build/test command. If it fails, fix the errors and run again. Repeat until it passes. NEVER set finalResponse true while a build is still failing.
7. NEVER claim you "fixed" or "created" something without having called writeFile or editFile. Saying it is not doing it.`;
}

function renderToolDocs() {
  const unconfigured = Object.keys(TOOL_REQUIRED_KEYS).filter(t => !_isToolConfigured(t));

  // Build the "no auth" warning section for unconfigured tools
  const noAuthSection = unconfigured.length > 0
    ? `\n\n## Unconfigured Tools [NO AUTH]
The following tools require API keys that are NOT set. **Do NOT call these tools.** If the user asks to use one, tell them to configure the required keys first (Settings page or \`daemora setup\`).
${unconfigured.map(t => `- ${t} — needs: ${TOOL_REQUIRED_KEYS[t].join(" or ")}`).join("\n")}`
    : "";

  return `# Available Tools

All tool params are STRINGS. Pass them as an array of strings.

## File Operations
- readFile(filePath, offset?, limit?) — Read file with line numbers. Always read before editing.
- writeFile(filePath, content) — Create or overwrite file. Content is the complete file.
- editFile(filePath, oldString, newString) — Find-and-replace (exactly 3 params). Read file first to get exact match string.
- applyPatch(filePath, patch) — Apply unified diff patch. Better than editFile for multi-hunk changes.
- listDirectory(dirPath) — List files and folders with types and sizes.
- searchFiles(pattern, directory?, optionsJson?) — Find files by name pattern. opts: {"sortBy":"modified","maxDepth":3}
- searchContent(pattern, directory?, optionsJson?) — Search inside files. opts: {"contextLines":2,"caseInsensitive":true,"fileType":"js","limit":50}
- glob(pattern, directory?) — Glob file search (e.g. "src/**/*.ts"). Sorted by recently modified.
- grep(pattern, optionsJson?) — Content search. opts: {"directory":"src","contextLines":3,"fileType":"js","outputMode":"content|files_only|count"}

## System
- executeCommand(command, optionsJson?) — Run shell command. opts: {"cwd":"/path","timeout":60000,"background":true}. Never run destructive commands without approval.

## Web & Browser
- webFetch(url, optionsJson?) — Fetch URL content as text. Caches 15 min. opts: {"maxChars":50000}
- webSearch(query, optionsJson?) — Search the web. opts: {"maxResults":5,"freshness":"day|week|month|year"}
- browserAction(action, param1?, param2?) — Heavy Playwright automation with accessibility snapshots.
  Workflow: navigate → snapshot (get refs e1,e2...) → act using refs → verify.
  **Navigation**: navigate(url), reload, goBack, goForward.
  **Snapshot**: snapshot(opts?) — ARIA tree with refs. Use "interactive" for clickable-only. Always snapshot before interacting.
  **Interaction**: click(ref|selector,opts?), fill(ref|selector,value), type(ref|selector,text), hover(ref|selector), selectOption(ref|selector,value), pressKey(key), scroll(direction|ref|selector,amount?), drag(source,target).
  **Inspection**: getText(ref|selector?), getContent(selector?), getLinks, console(filter?,limit?), screenshot(path|ref?,full?), pdf(path?), evaluate(js).
  **Waiting**: waitFor(condition,timeout?) — selector, "text:...", "url:...", "js:...", "load", "networkidle". waitForNavigation(timeout?).
  **State**: getCookies(domain?), setCookie(json), clearCookies, getStorage(local|session,key?), setStorage(json), clearStorage(local|session).
  **Files**: upload(ref|selector,filePath), download(ref|selector).
  **Tabs**: newTab(url?), switchTab(targetId), listTabs, closeTab(targetId?).
  **Other**: resize(WxH), highlight(ref|selector), handleDialog(accept|dismiss,text?), newSession(profile?), status, close.
  Localhost/127.0.0.1 allowed. Use refs from snapshot instead of CSS selectors.
${_isToolConfigured("sendEmail") ? `
## Communication
- sendEmail(to, subject, body, optionsJson?) — Send email via SMTP. opts: {"cc":"...","bcc":"...","attachments":[...]}` : ""}
- messageChannel(channel, target, message) — Send message on any channel. channel: "telegram"|"whatsapp"|"email".

## Documents
- createDocument(filePath, content, format?) — Create markdown (default), pdf, or docx document.

## Vision & Screen
- imageAnalysis(imagePath, prompt?) — Analyze image with vision model. Path or URL.
- screenCapture(optionsJson?) — Screenshot or video. opts: {"mode":"screenshot"|"video","outputDir":"/tmp","duration":10}. Chain with replyWithFile or imageAnalysis.
${_isToolConfigured("transcribeAudio") ? `- transcribeAudio(audioPath, prompt?) — Transcribe audio to text via Whisper. Formats: mp3, wav, m4a, webm, ogg, flac.` : ""}
${_isToolConfigured("textToSpeech") ? `- textToSpeech(text, optionsJson?) — Text to MP3. opts: {"voice":"nova|alloy|echo|fable|onyx|shimmer","provider":"openai|elevenlabs"}. Chain with replyWithFile.` : ""}
- replyWithFile(filePath, caption?) — Send file back to current user. Use for any generated file (screenshot, doc, audio).
- sendFile(channel, target, filePath, caption?) — Send file to a DIFFERENT user on a specific channel.

## Memory
- readMemory() — Read long-term MEMORY.md.
- writeMemory(entry, category?) — Add timestamped entry. category: "user-prefs", "project", "learned", etc.
- searchMemory(query, optionsJson?) — Search MEMORY.md and daily logs. opts: {"category":"...","limit":50}
- listMemoryCategories() — List all categories with entry counts.
- pruneMemory(maxAgeDays) — Delete entries older than N days (default: 90).
- readDailyLog(date?) — Read daily log for date (YYYY-MM-DD). Omit for today.
- writeDailyLog(entry) — Append to today's daily log.

## Agents
- spawnAgent(taskDescription, optionsJson?) — Spawn sub-agent. opts: {"profile":"coder|researcher|writer|analyst","extraTools":[...],"skills":["skills/coding.md"],"parentContext":"...","model":"..."}. Pass skills array with skill paths from the Available Skills list — the skill content is injected directly into the sub-agent so it can follow the instructions without loading them. Task description must be comprehensive — sub-agent has no other context.
- parallelAgents(tasksJson, sharedOptionsJson?) — Spawn multiple agents in parallel. tasksJson: [{"description":"...","options":{...}}]. sharedOptionsJson: {"sharedContext":"..."}. Always pass workspace path in sharedContext.
- manageAgents(action, paramsJson?) — List, kill, or steer agents. action: "list"|"kill"|"steer".

### useMCP(serverName, taskDescription)
Delegate a task to a specialist agent for the named MCP server.
- serverName: check "Connected MCP Servers" for available servers
- taskDescription: The specialist has ZERO context beyond what you write here. Include:
  1. **What to do** — clear action to perform
  2. **All details** — every name, address, date, ID, value the user provided
  3. **Full content** — write out complete messages/documents, never summarize
  4. **Context** — background needed to do the job correctly

- manageMCP(action, paramsJson?) — Inspect MCP servers. action: "list"|"status"|"tools". opts: {"server":"github"}
- delegateToAgent(agentUrl, taskInput) — Delegate to external agent via A2A protocol.

## Task & Project Management
- taskManager(action, paramsJson?) — Create/update/list tasks with hierarchy. Actions: createTask, updateTask, listTasks, getTask.
- projectTracker(action, paramsJson?) — Track multi-step projects. Actions: createProject, addTask, updateTask, getProject, listProjects, deleteProject. Persisted to disk.

## Automation
- cron(action, paramsJson?) — Schedule recurring tasks. action: "list"|"add"|"remove"|"run"|"status". opts for add: {"cronExpression":"...","taskInput":"...","name":"..."}${noAuthSection}`;
}

function renderMCPTools() {
  const servers = mcpManager.getConnectedServersInfo();
  if (servers.length === 0) return "";

  const serverList = servers
    .map((s) => {
      const desc = s.description ? ` - ${s.description}` : "";
      return `- **${s.name}**${desc} (${s.toolCount} tools: ${s.toolNames.join(", ")})`;
    })
    .join("\n");

  return `# Connected MCP Servers

The following MCP servers are connected. Use \`useMCP(serverName, taskDescription)\` to delegate tasks to a specialist agent for any server.

${serverList}

**IMPORTANT: ALWAYS prefer MCP server tools over built-in equivalents.** For example:
- To send email → use \`useMCP("Fastn", ...)\` (gmail_send_mail) instead of \`sendEmail\`
- To manage calendar → use \`useMCP("Fastn", ...)\` instead of built-in tools
- If an MCP server provides a capability, ALWAYS use it via \`useMCP\` first. Only fall back to built-in tools if no MCP server offers that capability.

Do NOT call mcp__ tools directly - always route through \`useMCP\`. The specialist agent receives only that server's tools for focused, efficient execution.
Use \`manageMCP("list")\` to check server connection status at any time.`;
}

function renderToolUsageRules() {
  return `# Tool Usage Rules

## Read Before Edit
- ALWAYS read a file before modifying it. Never edit blind.
- Use enough context in oldString for unambiguous match.

## Choose the Right Tool
- Small change → editFile. Major rewrite → writeFile. editFile keeps failing → switch to writeFile.
- Find content → searchContent/grep. Find files → searchFiles/glob/listDirectory (not executeCommand("ls")).

## Error Recovery
- editFile oldString not found → re-read file, retry with exact content.
- Command fails → read error, diagnose, try different approach.
- NEVER tell user to do something manually. Use tools.

## Don't Over-Engineer
- Only make changes directly requested or clearly necessary.
- No extra features, refactoring, or "improvements" beyond what was asked.
- No comments/docstrings/type annotations on untouched code.
- No error handling for impossible scenarios. No premature abstractions.
- Unused code → delete it completely. No backwards-compatibility hacks.

## Security
- No command injection, XSS, SQL injection, path traversal. Fix insecure code immediately.
- Never hardcode secrets. Use environment variables. Sanitize user input at boundaries.

## Quality
- Follow existing code conventions. Match project patterns. Check surrounding code first.
- Prefer simplest correct solution. Complexity is a cost.`;
}

async function renderSkills(taskInput, limit = 20) {
  const totalCount = skillLoader.list().length;
  if (totalCount === 0) return "";

  const summaries = await skillLoader.getMatchedSkillSummaries(taskInput, limit);
  if (!summaries || summaries.length === 0) return "";

  const lines = summaries.map(s =>
    `- ${s.name} (${s.path}) — ${s.description}`
  );
  const remaining = totalCount - summaries.length;
  const dirHint = remaining > 0
    ? `\n\n> ${totalCount} skills total in skills/ — run \`ls skills/\` to discover more.`
    : "";
  return `# Available Skills

Before replying, scan this list. If a skill applies, use readFile to load it, then follow it.

${lines.join("\n")}${dirHint}`;
}

function renderMemory() {
  const { memoryPath } = _getContextMemoryPaths();
  let memory = "";
  if (existsSync(memoryPath)) {
    memory = readFileSync(memoryPath, "utf-8").trim();
  }
  if (!memory) return "";
  return `# Agent Memory\n\n${memory}`;
}

function renderDailyLog() {
  const { memoryDir } = _getContextMemoryPaths();
  const today = new Date().toISOString().split("T")[0];
  const dailyLogPath = `${memoryDir}/${today}.md`;
  let dailyLog = "";
  if (existsSync(dailyLogPath)) {
    dailyLog = readFileSync(dailyLogPath, "utf-8").trim();
  }
  if (!dailyLog) return "";
  return `# Today's Log (${today})\n\n${dailyLog}`;
}

function renderOperationalGuidelines() {
  return `# Operational Guidelines

## Tone & Style
- Be concise. 1-3 lines per response. No filler phrases.
- Report what you DID in past tense. Don't narrate tool calls.
- Don't ask "shall I proceed?" — just do the work. Only confirm before destructive actions.

## Understanding Requirements
- Infer implied intent from vague requests. "make it look better" → spacing, typography, contrast, responsive.
- If truly ambiguous (two valid outcomes), ask ONE focused question. Otherwise just do it.
- Match existing code style, patterns, and conventions.

## Workflow: Read → Act → Verify → Fix → Report
1. **Read** every file before touching it.
2. **Act** with tools. editFile for small changes, writeFile for rewrites.
3. **Verify** — readFile after writes. Run build/tests after code changes.
4. **Fix** — if build/test fails, fix and re-verify. Loop until clean.
5. **Report** — set finalResponse true only after verification. Summarize in 1-3 sentences.
- NEVER set finalResponse true while a build error or test failure exists.

## When Blocked
- Don't brute force. Read the error, try a different approach.
- Tool fails twice with same params → stop and diagnose.
- Never use destructive workarounds to clear a blocker.

## What NOT To Do
- NEVER claim "fixed" without calling writeFile/editFile. NEVER plan without executing.
- NEVER ask user to do things manually. NEVER give up after one failure.
- NEVER set finalResponse true without verification. NEVER over-engineer.`;
}

function renderSubagentContext(taskDescription) {
  if (!taskDescription) return null;
  return `# Subagent Context

You are a sub-agent spawned for a specific task. Complete it fully without asking questions.

## Rules
- Execute the task end-to-end. Do not stop to ask the parent agent for clarification — figure it out.
- If matched skills were injected in your context, follow them precisely.
- If you need a skill not already injected, load it with \`readFile("skills/<name>.md")\` and follow its instructions.
- Use every tool, command, and skill available to you to finish the job.
- When done, report back: what you did, key outcomes, any issues found. Keep it concise.`;
}

function renderRuntime(meta = {}) {
  const parts = [];
  if (meta.model) parts.push(`model=${meta.model}`);
  if (meta.thinkingLevel) parts.push(`thinking=${meta.thinkingLevel}`);
  if (meta.agentId) parts.push(`agent=${meta.agentId}`);
  if (parts.length === 0) return null;
  return `Runtime: ${parts.join(" | ")}`;
}

export const systemPrompt = { role: "system", content: "" };
