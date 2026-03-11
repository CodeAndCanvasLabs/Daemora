import { z } from "zod";
import { tool } from "ai";

// ── Helpers ──────────────────────────────────────────────────────────────────
const str = (desc) => z.string().describe(desc);
const optStr = (desc) => z.string().optional().describe(desc);
const optNum = (desc) => z.number().optional().describe(desc);
const optBool = (desc) => z.boolean().optional().describe(desc);
const json = (desc) => z.string().optional().describe(`JSON string. ${desc}`);

// ── Tool Schemas ─────────────────────────────────────────────────────────────
// Each entry: { schema: z.object, description: string }
// schema defines named params the model must provide.
// description is a one-liner shown in system prompt.

const toolSchemas = {
  // ── File Operations ──────────────────────────────────────────────────────
  readFile: {
    schema: z.object({
      path: str("Absolute file path"),
      offset: optNum("Start line (1-based)"),
      limit: optNum("Max lines to read"),
    }),
    description: "Read file contents with optional offset/limit",
  },
  writeFile: {
    schema: z.object({
      path: str("Absolute file path"),
      content: str("Complete file content"),
    }),
    description: "Create or overwrite a file",
  },
  editFile: {
    schema: z.object({
      path: str("Absolute file path"),
      oldString: str("Exact text to find"),
      newString: str("Replacement text"),
    }),
    description: "Find-and-replace edit in a file",
  },
  listDirectory: {
    schema: z.object({
      path: optStr("Directory path (default: cwd)"),
    }),
    description: "List files and folders with types/sizes",
  },
  searchFiles: {
    schema: z.object({
      pattern: str("File name pattern with wildcards"),
      directory: optStr("Search directory"),
      options: json('{"sortBy":"modified","maxDepth":3}'),
    }),
    description: "Find files by name pattern",
  },
  searchContent: {
    schema: z.object({
      pattern: str("Search pattern (text or regex)"),
      directory: optStr("Search directory"),
      options: json('{"contextLines":2,"caseInsensitive":true,"fileType":"js","limit":50}'),
    }),
    description: "Search inside file contents",
  },
  glob: {
    schema: z.object({
      pattern: str("Glob pattern (e.g. src/**/*.ts)"),
      directory: optStr("Base directory"),
    }),
    description: "Glob file search, sorted by recently modified",
  },
  grep: {
    schema: z.object({
      pattern: str("Search pattern"),
      options: json('{"directory":"src","contextLines":3,"fileType":"js","outputMode":"content|files_only|count"}'),
    }),
    description: "Content search with context and filtering",
  },
  applyPatch: {
    schema: z.object({
      path: str("File path to patch"),
      patch: str("Unified diff or V4A patch content"),
    }),
    description: "Apply diff patch to a file (unified or V4A format)",
  },

  // ── System ───────────────────────────────────────────────────────────────
  executeCommand: {
    schema: z.object({
      command: str("Shell command to run"),
      options: json('{"cwd":"/path","timeout":60000,"background":true}'),
    }),
    description: "Run shell command. Use gh CLI for GitHub ops",
  },

  // ── Web & Browser ────────────────────────────────────────────────────────
  webFetch: {
    schema: z.object({
      url: str("URL to fetch"),
      options: json('{"maxChars":50000}'),
    }),
    description: "Fetch URL content as text (cached 15m)",
  },
  webSearch: {
    schema: z.object({
      query: str("Search query"),
      options: json('{"maxResults":5,"freshness":"day|week|month|year"}'),
    }),
    description: "Search the web",
  },
  browserAction: {
    schema: z.object({
      action: str("navigate|snapshot|click|fill|type|hover|selectOption|pressKey|scroll|drag|getText|getContent|screenshot|pdf|evaluate|getLinks|console|waitFor|waitForNavigation|reload|goBack|goForward|newTab|switchTab|listTabs|closeTab|getCookies|setCookie|clearCookies|getStorage|setStorage|clearStorage|upload|download|resize|highlight|handleDialog|newSession|status|close"),
      param1: optStr("Primary param (url, ref, selector, path, key, direction, condition, json, WxH, profile)"),
      param2: optStr("Secondary param (value, amount, timeout, text, target, full, filter, limit, targetId, local|session)"),
    }),
    description: "Playwright browser automation. Workflow: navigate → snapshot → act on refs → verify",
  },

  // ── Communication ────────────────────────────────────────────────────────
  sendEmail: {
    schema: z.object({
      to: str("Recipient email"),
      subject: str("Email subject"),
      body: str("Email body"),
      options: json('{"cc":"...","bcc":"...","attachments":[...]}'),
    }),
    description: "Send email via SMTP/Resend",
  },
  messageChannel: {
    schema: z.object({
      channel: str("telegram|whatsapp|email|discord|slack"),
      target: str("Chat ID, phone number, or email"),
      message: str("Message text"),
    }),
    description: "Send message on a specific channel",
  },
  sendFile: {
    schema: z.object({
      channel: str("telegram|discord|slack|email"),
      target: str("Chat ID, user ID, or email"),
      filePath: str("Absolute path to file"),
      caption: optStr("File caption"),
    }),
    description: "Send file to a user on a channel",
  },
  replyWithFile: {
    schema: z.object({
      filePath: str("Absolute path to file"),
      caption: optStr("File caption"),
    }),
    description: "Send file back to the current user",
  },
  replyToUser: {
    schema: z.object({
      message: str("Message text"),
    }),
    description: "Send text to current user mid-task (progress updates, acknowledgments)",
  },

  // ── Media ────────────────────────────────────────────────────────────────
  transcribeAudio: {
    schema: z.object({
      audioPath: str("Audio file path or URL"),
      prompt: optStr("Transcription hint"),
    }),
    description: "Transcribe audio to text via Whisper",
  },
  textToSpeech: {
    schema: z.object({
      text: str("Text to speak"),
      options: json('{"voice":"nova|alloy|echo|fable|onyx|shimmer","provider":"openai|elevenlabs"}'),
    }),
    description: "Convert text to audio MP3",
  },
  screenCapture: {
    schema: z.object({
      options: json('{"mode":"screenshot|video","outputDir":"/tmp","duration":10}'),
    }),
    description: "Capture screenshot or record video",
  },
  imageAnalysis: {
    schema: z.object({
      imagePath: str("Image file path or URL"),
      prompt: optStr("Analysis prompt"),
    }),
    description: "Analyze image with vision model",
  },
  generateImage: {
    schema: z.object({
      prompt: str("Image description"),
      options: json('{"model":"dall-e-3","size":"1024x1024","quality":"standard","style":"vivid","n":1}'),
    }),
    description: "Generate image with DALL-E",
  },

  // ── Documents ────────────────────────────────────────────────────────────
  createDocument: {
    schema: z.object({
      filePath: str("Output file path"),
      content: str("Markdown content"),
      format: optStr("markdown|pdf|docx (default: markdown)"),
    }),
    description: "Create markdown, PDF, or DOCX document",
  },
  readPDF: {
    schema: z.object({
      filePath: str("PDF file path"),
      options: json('{"pages":"1-5","method":"auto|pdftotext|vision"}'),
    }),
    description: "Extract text from PDF",
  },

  // ── Memory ───────────────────────────────────────────────────────────────
  readMemory: {
    schema: z.object({}),
    description: "Read long-term MEMORY.md",
  },
  writeMemory: {
    schema: z.object({
      entry: str("Memory entry text"),
      category: optStr("Category tag (user-prefs, project, learned, etc.)"),
    }),
    description: "Save entry to persistent memory",
  },
  readDailyLog: {
    schema: z.object({
      date: optStr("Date in YYYY-MM-DD (default: today)"),
    }),
    description: "Read daily log for a date",
  },
  writeDailyLog: {
    schema: z.object({
      entry: str("Log entry text"),
    }),
    description: "Append to today's daily log",
  },
  searchMemory: {
    schema: z.object({
      query: str("Search query"),
      options: json('{"category":"...","limit":50}'),
    }),
    description: "Search memory and daily logs (semantic + keyword)",
  },
  pruneMemory: {
    schema: z.object({
      maxAgeDays: optStr("Delete entries older than N days (default: 90)"),
    }),
    description: "Remove old memory entries",
  },
  listMemoryCategories: {
    schema: z.object({}),
    description: "List memory categories with entry counts",
  },

  // ── Agents ───────────────────────────────────────────────────────────────
  spawnAgent: {
    schema: z.object({
      taskDescription: str("Complete task brief for the sub-agent"),
      options: json('{"profile":"coder|researcher|writer|analyst","extraTools":[...],"skills":[...],"parentContext":"..."}'),
    }),
    description: "Spawn sub-agent for independent task",
  },
  parallelAgents: {
    schema: z.object({
      tasks: str('JSON array: [{"description":"...","options":{...}}]'),
      sharedOptions: json('{"sharedContext":"..."}'),
    }),
    description: "Spawn multiple sub-agents in parallel",
  },
  delegateToAgent: {
    schema: z.object({
      agentUrl: str("Remote agent URL"),
      taskInput: str("Task description for remote agent"),
    }),
    description: "Delegate to external agent via A2A protocol",
  },
  manageAgents: {
    schema: z.object({
      action: str("list|kill|steer|sessions|session_get|session_clear|session_clear_all"),
      params: json("Action-specific params"),
    }),
    description: "Manage sub-agents and sessions",
  },

  // ── Tasks & Projects ─────────────────────────────────────────────────────
  taskManager: {
    schema: z.object({
      action: str("createTask|updateTask|listTasks|getTask"),
      params: json("Action-specific params"),
    }),
    description: "Create/update/list tasks with hierarchy",
  },
  projectTracker: {
    schema: z.object({
      action: str("createProject|addTask|updateTask|getProject|listProjects|deleteProject"),
      params: json("Action-specific params"),
    }),
    description: "Track multi-step project progress",
  },

  // ── MCP ──────────────────────────────────────────────────────────────────
  manageMCP: {
    schema: z.object({
      action: str("list|status|tools|add|remove|enable|disable|reload"),
      params: json('{"server":"..."}'),
    }),
    description: "Inspect and manage MCP server connections",
  },
  useMCP: {
    schema: z.object({
      serverName: str("MCP server name"),
      taskDescription: str("Complete task description (specialist has zero context)"),
    }),
    description: "Delegate task to MCP specialist agent",
  },

  // ── Automation ───────────────────────────────────────────────────────────
  cron: {
    schema: z.object({
      action: str("list|add|remove|run|status|update|enable|disable"),
      params: json('{"cronExpression":"...","taskInput":"...","name":"..."}'),
    }),
    description: "Schedule recurring tasks (channel auto-detected)",
  },

  // ── Teams ────────────────────────────────────────────────────────────────
  teamTask: {
    schema: z.object({
      action: str("createTeam|addTeammate|spawnTeammate|spawnAll|addTask|claim|complete|failTask|listTasks|claimable|sendMessage|broadcast|readMail|mailHistory|status|disband"),
      params: json("Action-specific params"),
    }),
    description: "Multi-agent team coordination with shared tasks and messaging",
  },

  // ── Voice ────────────────────────────────────────────────────────────────
  makeVoiceCall: {
    schema: z.object({
      action: str("initiate|listen|speak|end|status|call|hangup|list"),
      target: optStr("Phone number or session ID"),
      options: json("Action-specific options"),
    }),
    description: "Outbound voice calls via Twilio",
  },

  // ── Git ──────────────────────────────────────────────────────────────────
  gitTool: {
    schema: z.object({
      action: str("clone|status|diff|log|add|commit|push|pull|branch|checkout|stash|reset|remote"),
      params: json("Action-specific params"),
    }),
    description: "Git operations (clone, commit, push, branch, etc.)",
  },

  // ── System & macOS ───────────────────────────────────────────────────────
  clipboard: {
    schema: z.object({
      action: str("read|write|clear"),
      text: optStr("Text to write (for write action)"),
    }),
    description: "Read/write system clipboard",
  },
  notification: {
    schema: z.object({
      title: str("Notification title"),
      message: str("Notification body"),
      options: json('{"service":"desktop|ntfy|pushover"}'),
    }),
    description: "Send desktop or push notification",
  },
  iMessageTool: {
    schema: z.object({
      action: str("send|read"),
      params: json("Action-specific params"),
    }),
    description: "Send/read iMessages and SMS on macOS",
  },
  calendar: {
    schema: z.object({
      action: str("list|create|search"),
      params: json("Action-specific params"),
    }),
    description: "Read/create calendar events (macOS or Google)",
  },
  contacts: {
    schema: z.object({
      action: str("search|list|get"),
      params: json("Action-specific params"),
    }),
    description: "Search/read contacts (macOS or Google)",
  },

  // ── Network & Remote ─────────────────────────────────────────────────────
  sshTool: {
    schema: z.object({
      action: str("exec|upload|download|keygen"),
      params: json("Action-specific params"),
    }),
    description: "Execute commands/transfer files over SSH",
  },
  database: {
    schema: z.object({
      action: str("query|execute|schema|list"),
      params: json("Action-specific params"),
    }),
    description: "Query SQLite, PostgreSQL, or MySQL databases",
  },

  // ── External Services ────────────────────────────────────────────────────
  googlePlaces: {
    schema: z.object({
      action: str("search|details|nearby|autocomplete"),
      params: json("Action-specific params"),
    }),
    description: "Search places, get details, find nearby",
  },
  philipsHue: {
    schema: z.object({
      action: str("list|on|off|brightness|color|scene|discover"),
      params: json("Action-specific params"),
    }),
    description: "Control Philips Hue smart lights",
  },
  sonos: {
    schema: z.object({
      action: str("play|pause|stop|next|prev|volume|mute|queue|info"),
      params: json("Action-specific params"),
    }),
    description: "Control Sonos speakers",
  },
};

// ── Exports ──────────────────────────────────────────────────────────────────

/**
 * Get Zod schema for a tool. Returns null if unknown.
 */
export function getToolSchema(toolName) {
  return toolSchemas[toolName]?.schema || null;
}

/**
 * Validate params against a tool's schema.
 * Returns { success: true, data } or { success: false, error: string }.
 */
export function validateToolParams(toolName, params) {
  const schema = getToolSchema(toolName);
  if (!schema) return { success: true, data: params }; // No schema = passthrough

  const result = schema.safeParse(params);
  if (result.success) return { success: true, data: result.data };

  const issues = result.error.issues
    .map((i) => `${i.path.join(".")}: ${i.message}`)
    .join("; ");
  return { success: false, error: `Invalid params for ${toolName}: ${issues}` };
}

/**
 * Get one-line description for a tool.
 */
export function getToolDescription(toolName) {
  return toolSchemas[toolName]?.description || null;
}

/**
 * Get all tool names that have schemas.
 */
export function getSchemaToolNames() {
  return Object.keys(toolSchemas);
}

/**
 * Build concise tool docs for system prompt.
 * Returns "- toolName: description" lines.
 */
export function buildToolDocLines(availableTools) {
  const lines = [];
  for (const name of Object.keys(toolSchemas)) {
    if (availableTools && !availableTools.has(name)) continue;
    lines.push(`- ${name}: ${toolSchemas[name].description}`);
  }
  return lines;
}

/**
 * Build Vercel AI SDK tool definitions for generateText().
 * Returns { toolName: tool({ description, inputSchema }) } — no execute.
 * Dispatch is handled manually in AgentLoop with guards.
 */
export function buildAITools(availableNames) {
  const aiTools = {};
  for (const name of availableNames) {
    const entry = toolSchemas[name];
    if (!entry) continue;
    aiTools[name] = tool({
      description: entry.description,
      inputSchema: entry.schema,
    });
  }
  return aiTools;
}

export default toolSchemas;
