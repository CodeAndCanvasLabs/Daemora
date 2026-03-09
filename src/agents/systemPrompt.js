import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { config } from "../config/default.js";
import skillLoader from "../skills/SkillLoader.js";
import mcpManager from "../mcp/MCPManager.js";
import tenantContext from "../tenants/TenantContext.js";

// Pre-computed absolute skill paths (cross-platform via join)
const _skillPath = (name) => join(config.skillsDir, `${name}.md`);

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
        renderMemory(),
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

## When to use each type

### type = "tool_call"
- User asks to DO something → FIRST response is always a tool call. Not text. Not a plan.
- Set tool_call.tool_name and tool_call.params (array of STRINGS).
- Set text_content to null, finalResponse to false.
- Chain tool calls across turns until the work is verified complete.

### type = "text"
- Conversation (greetings, questions, chat) → reply naturally. finalResponse = true.
- Task complete and verified → concise outcome in 1-3 sentences. finalResponse = true.

## Task execution rules
1. **Decide: plan or just do it.** Simple task (single action, clear instructions, quick fix) → start immediately with a tool call. Complex task (3+ steps, multiple approaches, unclear scope, high stakes, multi-agent, new feature, multi-file changes) → load the planning skill first (\`readFile("${_skillPath("planning")}")\`), gather context, break into steps, **present the plan to the user and get confirmation before executing**. When in doubt → plan. The cost of planning is low; the cost of rework is high.
2. Chain multiple tool calls. After each result: need more? Call another. Done? Verify first, then finalize.
3. After writing/editing any file, read it back to verify.
4. After code changes, run build/tests. Fix failures until clean.
5. Tool fails → try a different approach. That fails → try another. Exhaust every option before reporting failure.
6. Never give up. Never ask the user to do it manually. Never report a problem without attempting to solve it.
7. Never claim you did something without actually calling the tool.
8. Never set finalResponse=true while errors or failures exist.
9. If 3+ steps into execution and something doesn't add up → stop, re-read the request, re-plan from current state.

## Understanding user intent
- Read the full request carefully. Identify exactly what the user wants done.
- Infer context from conversation history, memory, and available information.
- If the request has multiple parts, handle all of them. Don't skip any.
- If genuinely ambiguous, ask ONE focused question. Otherwise just do it.

## Final response format
- 1-3 sentences. What happened, from the user's perspective.
- Never dump tool output, full email bodies, API responses, status codes, message IDs, or JSON.
- Never ask what to do next or offer follow-up options.
- Never expose internal details (tool names, IDs, technical artifacts).

## Output efficiency
These rules apply to text responses sent to the user — NOT to tool params, sub-agent instructions, or task descriptions (those must remain detailed and complete).
- Go straight to the point. Try the simplest approach first.
- Lead with the answer or action, not the reasoning.
- Skip filler words, preamble, and unnecessary transitions.
- If you can say it in one sentence, don't use three.
- Focus text on: decisions needing input, status updates at milestones, errors that change the plan.`;
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
Use existing conversation context first — if you already have the data from a previous tool call, web search, file read, or user message, work with that. Only call a tool again when you need fresh or missing information.

## File Operations
Always use absolute paths. Resolve ~ and relative paths from the user's context before calling any file tool.
- MUST read a file before modifying it. Never edit blind — this will error if you haven't read the file first.
- Don't re-read files already in context. Use existing content — only re-read if you need fresh state after an edit.
- Read only what you need: use offset/limit to target specific sections, not the entire file.
- Prefer editFile for modifying existing files — it only sends the diff. Most edits should use this.
- applyPatch for multi-hunk changes — better than multiple editFile calls.
- writeFile only for creating new files or complete rewrites. Never writeFile to change a few lines.
- readFile(filePath, offset?, limit?) — Read file with line numbers. Use offset/limit to read specific sections.
- writeFile(filePath, content) — Create or overwrite file. Content is the complete file.
- editFile(filePath, oldString, newString) — Find-and-replace (exactly 3 params). Supports flexible whitespace matching.
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
Persistent memory per tenant. Contents survive across conversations. Consult memory to build on previous experience.
- readMemory() — Read long-term MEMORY.md.
- writeMemory(entry, category?) — Add timestamped entry. category: "user-prefs", "project", "learned", etc.
- searchMemory(query, optionsJson?) — Search MEMORY.md and daily logs. opts: {"category":"...","limit":50}
- listMemoryCategories() — List all categories with entry counts.
- pruneMemory(maxAgeDays) — Delete entries older than N days (default: 90).
- readDailyLog(date?) — Read daily log for date (YYYY-MM-DD). Omit for today.
- writeDailyLog(entry) — Append to today's daily log.

### What to save
- User preferences for workflow, tools, and communication style.
- Key architectural decisions, important file paths, and project structure.
- Solutions to recurring problems and debugging insights.
- When the user asks to remember something across sessions, save it immediately.

### What NOT to save
- Session-specific context (current task details, in-progress work, temporary state).
- Speculative or unverified conclusions from a single interaction.
- Information that duplicates what's already in memory — check first, update existing entries.

### When to use memory
- Start of a new conversation → readMemory() to recall user preferences and context.
- User gives a preference or rule → writeMemory() immediately, don't wait.
- User asks to forget something → find and remove the relevant entry.
- Learned something stable across multiple interactions → save it.
- Daily log for task tracking → writeDailyLog() at end of significant work.

## Agents
For complex multi-agent tasks, load \`readFile("${_skillPath("orchestration")}")\` first — covers parallel execution, contract-based planning, workspace artifacts, and coordination patterns.
- spawnAgent(taskDescription, optionsJson?) — Spawn sub-agent. opts: {"profile":"coder|researcher|writer|analyst","extraTools":[...],"skills":["${_skillPath("coding")}"],"parentContext":"...","model":"..."}. Pass skills array with skill paths from the Available Skills list — the skill content is injected directly into the sub-agent so it can follow the instructions without loading them. Task description must be comprehensive — sub-agent has no other context.
- parallelAgents(tasksJson, sharedOptionsJson?) — Spawn multiple agents in parallel. tasksJson: [{"description":"...","options":{...}}]. sharedOptionsJson: {"sharedContext":"..."}. Always pass workspace path and shared contract in sharedContext.
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

**Prefer MCP servers over built-in tools** when both can do the job. Route tasks through \`useMCP(serverName, taskDescription)\` — the specialist gets only that server's tools. Do not call mcp__ tools directly.

**Never expose MCP tool names to the user.** When describing capabilities, use natural language (e.g. "I can manage your calendar" not "I have google_calendar_create_event"). Internal tool names are implementation details.`;
}

function renderToolUsageRules() {
  return `# Tool Usage Rules

## Workflow
1. Read → understand before touching anything.
2. Act → editFile for small changes, writeFile for rewrites. Use tools, never tell the user to do it manually.
3. Verify → readFile after writes. Run build/tests after code changes.
4. Fix → build/test fails → fix and re-verify until clean.
5. Report → 1-3 sentences. What happened, key outcomes. No raw output, no internal details.

## Tool Selection
- Small change → editFile. Full rewrite → writeFile. editFile keeps failing → switch to writeFile.
- Find content → searchContent/grep. Find files → searchFiles/glob/listDirectory.
- editFile oldString not found → re-read file, retry with exact content.

## Error Recovery
- Tool fails → read error, try different approach. Fails again → try another. Exhaust options before reporting failure.
- Same params fail twice → stop and diagnose. Don't brute force.
- Never use destructive workarounds to clear a blocker.

## Code Quality
- Read before edit. Always. Use enough context in oldString for unambiguous match.
- Follow existing conventions. Match project patterns. Simplest correct solution wins.
- Only change what's requested. No extra features, refactoring, or "improvements" beyond scope.
- No comments/docstrings on untouched code. No error handling for impossible scenarios.
- Unused code → delete completely. No backwards-compatibility hacks.
- No command injection, XSS, SQL injection, path traversal. Never hardcode secrets.

## What NOT To Do
- NEVER expose raw API responses, status codes, message IDs, or internal artifacts.
- NEVER ask what to do next or offer follow-up options. Either do it or don't.
- NEVER claim "fixed" without calling writeFile/editFile. NEVER plan without executing.
- NEVER ask user to do things manually. NEVER give up after one failure.
- NEVER set finalResponse true without verification or while errors exist.

## Context Management
- \`<conversation-summary>\` blocks are compacted history — treat as ground truth for earlier work.
- Don't re-do work mentioned in the summary. Continue from where it left off.
- If context is growing long, write key decisions to memory before they get compacted.`;
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
    ? `\n\n> ${totalCount} skills total in ${config.skillsDir} — run \`ls ${config.skillsDir}\` to discover more.`
    : "";
  return `# Available Skills

Before replying, scan this list. If a skill applies, use readFile to load it, then follow it.
Skills that need API keys or credentials access them from the runtime environment automatically — never ask the user for keys in chat.

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

// renderOperationalGuidelines merged into renderToolUsageRules

function renderSubagentContext(taskDescription) {
  if (!taskDescription) return null;
  return `# Subagent Context

You are a sub-agent spawned for a specific task. Complete it fully without asking questions.

## Rules
- Execute the task end-to-end. Do not stop to ask the parent agent for clarification — figure it out.
- If matched skills were injected in your context, follow them precisely.
- If you need a skill not already injected, load it with \`readFile("<path from Available Skills list>")\` and follow its instructions.
- Use every tool, command, and skill available to you to finish the job.
- When done, report back: what you did, key outcomes, any issues found. Keep it concise.`;
}

function renderRuntime(meta = {}) {
  const now = new Date();
  const date = now.toISOString().split("T")[0];
  const time = now.toTimeString().split(" ")[0];
  const year = now.getFullYear();
  const parts = [];
  if (meta.model) parts.push(`Model: ${meta.model}`);
  if (meta.thinkingLevel) parts.push(`Thinking: ${meta.thinkingLevel}`);
  if (meta.agentId) parts.push(`Agent: ${meta.agentId}`);
  return `# Environment

- Current Date: ${date}
- Current Time: ${time}
- Current Year: ${year}
- OS: ${process.platform}/${process.arch}
- Shell: ${process.env.SHELL || "unknown"}
- CWD: ${process.cwd()}
${parts.length > 0 ? parts.map(p => `- ${p}`).join("\n") + "\n" : ""}`;
}

export const systemPrompt = { role: "system", content: "" };
