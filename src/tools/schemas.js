import { z } from "zod";
import { tool } from "ai";

// ── Helpers ──────────────────────────────────────────────────────────────────
const str = (desc) => z.string().describe(desc);
const optStr = (desc) => z.string().optional().describe(desc);
const optNum = (desc) => z.number().optional().describe(desc);
const optBool = (desc) => z.boolean().optional().describe(desc);

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
      sortBy: optStr("Sort order: 'modified'"),
      maxDepth: optNum("Max directory depth"),
      minSize: optStr("Min file size: '10k', '1m'"),
      maxSize: optStr("Max file size: '10k', '1m'"),
    }),
    description: "Find files by name pattern",
  },
  searchContent: {
    schema: z.object({
      pattern: str("Search pattern (text or regex)"),
      directory: optStr("Search directory"),
      limit: optNum("Max results (default: 50)"),
      caseInsensitive: optBool("Case insensitive search"),
      contextLines: optNum("Lines of context around matches"),
      fileType: optStr("Filter by extension: 'js', 'ts', 'py'"),
      regex: optBool("Treat pattern as regex"),
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
      directory: optStr("Search directory (default: cwd)"),
      contextLines: optNum("Lines of context around matches"),
      caseInsensitive: optBool("Case insensitive search"),
      fileType: optStr("Filter by extension: 'js', 'ts', 'py'"),
      outputMode: optStr("Output: 'content' | 'files_only' | 'count'"),
      limit: optNum("Max results (default: 50)"),
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
      cwd: optStr("Working directory"),
      timeout: optNum("Timeout in ms (default: 120000, max: 600000)"),
      background: optBool("Run in background"),
    }),
    description: "Run shell command. Use gh CLI for GitHub ops",
  },

  // ── Web & Browser ────────────────────────────────────────────────────────
  webFetch: {
    schema: z.object({
      url: str("URL to fetch"),
      maxChars: optNum("Max chars to return (default: 50000)"),
    }),
    description: "Fetch URL content as text (cached 15m)",
  },
  webSearch: {
    schema: z.object({
      query: str("Search query"),
      maxResults: optNum("Max results (default: 5)"),
      freshness: optStr("Recency filter: 'day' | 'week' | 'month' | 'year'"),
      provider: optStr("Search provider: 'brave' | 'ddg'"),
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
      to: str("Recipient email(s), comma-separated"),
      subject: str("Email subject"),
      body: str("Email body"),
      cc: optStr("CC recipients, comma-separated"),
      bcc: optStr("BCC recipients, comma-separated"),
      replyTo: optStr("Reply-to address"),
      attachments: z.array(z.object({
        filename: str("File name"),
        path: str("Absolute file path"),
      })).optional().describe("File attachments"),
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
      filePath: str("Absolute path to file"),
      caption: optStr("File caption"),
      channel: optStr("Target channel: 'telegram', 'discord', 'slack', etc. Cross-channel auto-resolved from tenant's linked accounts — no chat ID needed"),
    }),
    description: "Send file to user. Omit channel = current channel. Set channel = cross-channel delivery (auto-resolved, never ask user for IDs).",
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
      voice: optStr("Voice: 'nova' | 'alloy' | 'echo' | 'fable' | 'onyx' | 'shimmer' (default: nova)"),
      speed: optNum("Speed 0.25-4.0 (default: 1.0)"),
      format: optStr("Output: 'mp3' | 'opus' | 'aac' | 'flac' (default: mp3)"),
      hd: optBool("Use HD model (default: true)"),
      provider: optStr("Provider: 'openai' | 'elevenlabs' | 'auto' (default: auto)"),
      voiceId: optStr("ElevenLabs voice ID"),
      modelId: optStr("ElevenLabs model ID"),
      stability: optNum("ElevenLabs stability 0-1"),
      similarityBoost: optNum("ElevenLabs similarity 0-1"),
    }),
    description: "Convert text to audio MP3",
  },
  screenCapture: {
    schema: z.object({
      mode: optStr("Capture mode: 'screenshot' | 'video' (default: screenshot)"),
      outputDir: optStr("Output directory"),
      duration: optNum("Video duration in seconds (default: 10)"),
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
      model: optStr("Model: 'dall-e-3' | 'dall-e-2' (default: dall-e-3)"),
      size: optStr("Size: '1024x1024' | '1792x1024' | '1024x1792' (default: 1024x1024)"),
      quality: optStr("Quality: 'standard' | 'hd' (default: standard)"),
      style: optStr("Style: 'vivid' | 'natural' (default: vivid)"),
      n: optNum("Number of images (default: 1)"),
      outputPath: optStr("Custom output file path"),
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
      pages: optStr("Page range: '1-5', '3', '10-20'"),
      method: optStr("Extraction: 'auto' | 'pdftotext' | 'vision' (default: auto)"),
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
      category: optStr("Filter by category"),
      limit: optNum("Max results (default: 20)"),
      minScore: optNum("Min similarity score 0-1 (default: 0.40)"),
      mode: optStr("Search mode: 'auto' | 'semantic' | 'keyword' (default: auto)"),
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
      taskDescription: str("Complete task brief — include what, constraints, files/APIs, expected output. Agent has zero other context."),
      profile: optStr("Agent profile: 'coder' | 'researcher' | 'writer' | 'analyst'"),
      parentContext: optStr("Extra context from parent task"),
      extraTools: z.array(z.string()).optional().describe("Additional tool names to enable"),
      skills: z.array(z.string()).optional().describe("Skill names to load"),
    }),
    description: "Spawn specialist sub-agent. Use for any deep-focus task: research, writing, coding, analysis. Profile sets identity.",
  },
  parallelAgents: {
    schema: z.object({
      tasks: z.array(z.object({
        description: str("Task description"),
        profile: optStr("Agent profile: 'coder' | 'researcher' | 'writer' | 'analyst'"),
      })).describe("Array of tasks to run in parallel"),
      sharedContext: optStr("Context shared across all agents"),
    }),
    description: "Spawn multiple sub-agents simultaneously for independent tasks.",
  },
  delegateToAgent: {
    schema: z.object({
      agentUrl: str("Remote agent URL"),
      taskInput: str("Task description for remote agent"),
    }),
    description: "Send task to external agent via A2A protocol",
  },
  manageAgents: {
    schema: z.object({
      action: str("list|kill|steer|sessions|session_get|session_clear|session_clear_all"),
      agentId: optStr("Agent ID (required for kill, steer)"),
      message: optStr("Steering message (required for steer)"),
      sessionId: optStr("Session ID (required for session_get, session_clear)"),
      count: optNum("Number of messages to retrieve (default: 5)"),
    }),
    description: "List, kill, or steer running sub-agents",
  },

  // ── Tasks & Projects ─────────────────────────────────────────────────────
  taskManager: {
    schema: z.object({
      action: str("createTask|updateTask|listTasks|getTask"),
      title: optStr("Task title (required for createTask)"),
      description: optStr("Task description"),
      status: optStr("Status: 'pending' | 'in_progress' | 'completed' | 'failed'"),
      parentTaskId: optStr("Parent task ID for hierarchy"),
      taskId: optStr("Task ID (required for updateTask, getTask)"),
      result: optStr("Task result text"),
      agentId: optStr("Agent ID to assign"),
      limit: optNum("Max tasks to list (default: 20)"),
    }),
    description: "Create/update/list tasks with hierarchy",
  },
  projectTracker: {
    schema: z.object({
      action: str("createProject|addTask|updateTask|getProject|listProjects|deleteProject"),
      name: optStr("Project name (required for createProject)"),
      description: optStr("Project or task description"),
      projectId: optStr("Project ID (required for addTask, updateTask, getProject, deleteProject)"),
      title: optStr("Task title (required for addTask)"),
      taskId: optStr("Task ID (required for updateTask)"),
      status: optStr("Task status: 'pending' | 'in_progress' | 'done' | 'failed' | 'skipped'"),
      notes: optStr("Update notes"),
      limit: optNum("Max results (default: 20)"),
    }),
    description: "Track multi-step project progress",
  },

  // ── MCP ──────────────────────────────────────────────────────────────────
  manageMCP: {
    schema: z.object({
      action: str("list|status|tools|add|remove|enable|disable|reload"),
      server: optStr("Server name (for tools filter)"),
      name: optStr("Server name (for add/remove/enable/disable/reload)"),
      command: optStr("Server command (for add)"),
      args: z.array(z.string()).optional().describe("Command arguments (for add)"),
      url: optStr("Server URL (for add, SSE/streamable transport)"),
      transport: optStr("Transport type: 'stdio' | 'sse' | 'streamable-http'"),
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
      action: str("add|list|status|update|enable|disable|remove|run|history"),
      id: optStr("Job ID (required for update/enable/disable/remove/run/history)"),
      name: optStr("Human-readable job name"),
      taskInput: optStr("The prompt to execute autonomously (required for add)"),
      cronExpression: optStr("Cron expression for recurring: '0 9 * * *' (daily 9am), '*/30 * * * *' (every 30min)"),
      every: optStr("Interval shorthand for repeating: '30m', '2h', '1d'"),
      at: optStr("ISO timestamp for one-shot: '2026-03-15T10:00:00Z'. Use for 'in X minutes' — compute the timestamp"),
      timezone: optStr("IANA timezone: 'America/New_York'"),
      model: optStr("Model override for this job"),
      deleteAfterRun: optBool("Auto-delete after one-shot run (use with 'at')"),
      delivery: z.object({
        mode: optStr("Delivery mode: 'announce'"),
        channel: optStr("Target channel name"),
        channelMeta: z.object({
          channel: optStr("Channel name"),
          chatId: optStr("Chat ID"),
          channelId: optStr("Channel ID"),
          userId: optStr("User ID"),
        }).optional().describe("Channel routing metadata"),
      }).optional().describe("Cross-channel delivery override. Auto-set to calling channel if omitted"),
    }),
    description: "Schedule and manage cron jobs. Delivery auto-routes to calling channel. Schedule types: cronExpression (recurring), every (interval), at (one-shot timestamp).",
  },

  // ── System Reload ──────────────────────────────────────────────────────
  reload: {
    schema: z.object({
      action: str("all|config|models|skills|mcp|scheduler|channels|vault|caches|status"),
    }),
    description: "Hot-reload system components without restart (config, models, skills, mcp, scheduler, channels, vault, caches)",
  },

  // ── Teams ────────────────────────────────────────────────────────────────
  teamTask: {
    schema: z.object({
      action: str("createTeam|addTeammate|spawnTeammate|spawnAll|addTask|claim|complete|failTask|listTasks|claimable|sendMessage|broadcast|readMail|mailHistory|status|disband"),
      teamId: optStr("Team ID (required for most actions)"),
      name: optStr("Team name (for createTeam)"),
      profile: optStr("Teammate profile: 'coder' | 'researcher' | 'writer' | 'analyst' (for addTeammate)"),
      instructions: optStr("Teammate instructions (for addTeammate)"),
      teammateId: optStr("Teammate ID (for spawnTeammate, claim, complete, failTask)"),
      context: optStr("Context string (for spawnTeammate, spawnAll)"),
      title: optStr("Task title (for addTask)"),
      description: optStr("Task description (for addTask)"),
      blockedBy: z.array(z.string()).optional().describe("Task IDs this task depends on (for addTask)"),
      taskId: optStr("Task ID (for claim, complete, failTask)"),
      result: optStr("Task result (for complete)"),
      reason: optStr("Failure reason (for failTask)"),
      status: optStr("Filter by status (for listTasks)"),
      assignee: optStr("Filter by assignee (for listTasks)"),
      to: optStr("Recipient teammate ID (for sendMessage)"),
      message: optStr("Message text (for sendMessage, broadcast)"),
      from: optStr("Sender ID (default: 'lead')"),
      recipientId: optStr("Recipient ID (for readMail)"),
      limit: optNum("Max results (for mailHistory, default: 50)"),
      id: optStr("Custom teammate ID (for addTeammate)"),
    }),
    description: "Coordinate a team of sub-agents with shared tasks, dependencies, and messaging. Use for multi-stage work with handoffs.",
  },

  // ── Voice ────────────────────────────────────────────────────────────────
  makeVoiceCall: {
    schema: z.object({
      action: str("initiate|listen|speak|end|status|call|hangup|list"),
      target: optStr("Phone number or session ID"),
      greeting: optStr("Initial greeting for initiate"),
      from: optStr("Caller ID phone number"),
      message: optStr("Message to speak (for speak, call)"),
      url: optStr("TwiML URL (for call)"),
      voice: optStr("Voice name (for call)"),
      language: optStr("Language code (for call)"),
      timeout: optNum("Timeout in seconds"),
      record: optBool("Record the call"),
      machineDetection: optStr("Machine detection mode (for initiate)"),
      model: optStr("AI model override (for initiate)"),
      statusCallback: optStr("Status callback URL (for call)"),
      sid: optStr("Call SID (for hangup)"),
      limit: optNum("Max results (for list, default: 20)"),
      status: optStr("Filter by status (for list)"),
    }),
    description: "Outbound voice calls via Twilio",
  },

  // ── Meetings + Voice Cloning ─────────────────────────────────────────────
  meetingAction: {
    schema: z.object({
      action: str("join|leave|speak|listen|transcript|status|participants|mute|unmute|cloneVoice|listVoices|deleteVoice|voiceInfo|voiceSettings|setVoice"),
      url: optStr("Meeting URL (required for join)"),
      sessionId: optStr("Session ID (required for most actions)"),
      displayName: optStr("Bot display name in meeting (for join)"),
      profile: optStr("Browser profile name (for join)"),
      voiceId: optStr("ElevenLabs voice ID (for join, setVoice, voiceInfo, voiceSettings, deleteVoice)"),
      sttProvider: optStr("STT provider: 'whisper' | 'deepgram' | 'groq' (for join)"),
      ttsProvider: optStr("TTS provider: 'elevenlabs' | 'openai' (for join)"),
      text: optStr("Text to speak (required for speak)"),
      last: optNum("Number of transcript entries to return (for listen/transcript)"),
      name: optStr("Voice name (required for cloneVoice)"),
      samplePaths: optStr("Audio sample file paths, comma-separated (required for cloneVoice)"),
      description: optStr("Voice description (for cloneVoice)"),
      source: optStr("Voice list source: 'tenant' | 'all' (for listVoices)"),
      stability: optNum("Voice stability 0-1 (for voiceSettings)"),
      similarityBoost: optNum("Voice similarity boost 0-1 (for voiceSettings)"),
      style: optNum("Voice style 0-1 (for voiceSettings)"),
      useSpeakerBoost: optBool("Use speaker boost (for voiceSettings)"),
    }),
    description: "Join video meetings (Zoom/Meet/Teams), speak/listen with voice cloning (ElevenLabs). Manage meeting sessions and cloned voices.",
  },

  // ── Git ──────────────────────────────────────────────────────────────────
  gitTool: {
    schema: z.object({
      action: str("clone|status|diff|log|add|commit|push|pull|branch|checkout|stash|reset|remote"),
      path: optStr("Repository path (default: cwd)"),
      url: optStr("Repository URL (for clone)"),
      dest: optStr("Clone destination directory"),
      branch: optStr("Branch name"),
      name: optStr("Branch name (for branch create/delete)"),
      files: optStr("Files to stage: path or comma-separated paths (for add, default: '.')"),
      message: optStr("Commit message (required for commit)"),
      all: optBool("Stage all changes (for commit)"),
      force: optBool("Force push (for push)"),
      remote: optStr("Remote name (default: 'origin')"),
      file: optStr("Specific file (for diff, checkout, reset)"),
      staged: optBool("Show staged changes (for diff)"),
      n: optNum("Number of log entries (default: 20)"),
      oneline: optBool("One-line log format (default: true)"),
      create: optBool("Create new branch (for checkout)"),
      delete: optBool("Delete branch (for branch)"),
      list: optBool("List branches (for branch)"),
      hard: optBool("Hard reset (for reset)"),
      sub: optStr("Stash sub-command: 'push' | 'pop' | 'list' | 'drop'"),
      rebase: optBool("Rebase on pull (for pull)"),
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
      service: optStr("Service: 'desktop' | 'ntfy' | 'pushover' (default: desktop)"),
      sound: optBool("Play sound"),
      url: optStr("URL for ntfy/pushover"),
      topic: optStr("Topic for ntfy"),
      urgency: optStr("Urgency: 'low' | 'normal' | 'critical' (Linux)"),
      expireMs: optNum("Auto-dismiss timeout in ms (Linux, default: 5000)"),
    }),
    description: "Send desktop or push notification",
  },
  iMessageTool: {
    schema: z.object({
      action: str("send|read"),
      to: optStr("Phone number or email (required for send)"),
      message: optStr("Message text (required for send)"),
      service: optStr("Service: 'iMessage' | 'SMS' (default: iMessage)"),
      count: optNum("Number of messages to read (default: 10)"),
    }),
    description: "Send/read iMessages and SMS on macOS",
  },
  calendar: {
    schema: z.object({
      action: str("list|create|search"),
      provider: optStr("Provider: 'macos' | 'google' (default: macos)"),
      days: optNum("Days ahead to list (default: 7)"),
      calendarId: optStr("Google Calendar ID"),
      calendarName: optStr("macOS calendar name (default: 'Calendar')"),
      title: optStr("Event title (required for create)"),
      startDate: optStr("ISO start date (required for create)"),
      endDate: optStr("ISO end date"),
      notes: optStr("Event notes"),
      query: optStr("Search query (required for search)"),
      maxResults: optNum("Max results for Google (default: 10)"),
    }),
    description: "Read/create calendar events (macOS or Google)",
  },
  contacts: {
    schema: z.object({
      action: str("search|list|get"),
      provider: optStr("Provider: 'macos' | 'google' (default: macos)"),
      query: optStr("Search query"),
      name: optStr("Contact name (required for get)"),
      limit: optNum("Max results (default: 20)"),
    }),
    description: "Search/read contacts (macOS or Google)",
  },

  // ── Network & Remote ─────────────────────────────────────────────────────
  sshTool: {
    schema: z.object({
      action: str("exec|upload|download|keygen"),
      host: optStr("SSH host (required for exec/upload/download)"),
      user: optStr("SSH user (default: root)"),
      port: optNum("SSH port (default: 22)"),
      keyPath: optStr("SSH private key path"),
      timeout: optNum("Connection timeout in seconds (default: 30)"),
      command: optStr("Command to execute (required for exec)"),
      localPath: optStr("Local file path (required for upload/download)"),
      remotePath: optStr("Remote file path (required for upload/download)"),
    }),
    description: "Execute commands/transfer files over SSH",
  },
  database: {
    schema: z.object({
      action: str("query|execute|schema|list"),
      type: optStr("Database type: 'sqlite' | 'postgres' | 'mysql' (default: sqlite)"),
      dbPath: optStr("SQLite database file path"),
      connectionString: optStr("PostgreSQL/MySQL connection string"),
      query: optStr("SQL query (required for query/execute)"),
      table: optStr("Table name filter (for schema)"),
      values: z.array(z.unknown()).optional().describe("Query parameter values"),
    }),
    description: "Query SQLite, PostgreSQL, or MySQL databases",
  },

  // ── External Services ────────────────────────────────────────────────────
  googlePlaces: {
    schema: z.object({
      action: str("search|details|nearby|autocomplete"),
      query: optStr("Search query (for search)"),
      input: optStr("Autocomplete input text (for autocomplete)"),
      location: optStr("Coordinates 'lat,lng' (for search, nearby, autocomplete)"),
      radius: optNum("Search radius in meters (default: 5000)"),
      type: optStr("Place type filter"),
      limit: optNum("Max results (default: 5)"),
      placeId: optStr("Place ID (required for details)"),
      fields: optStr("Fields to return (for details)"),
      includeReviews: optBool("Include reviews (for details)"),
      apiKey: optStr("Google API key override"),
    }),
    description: "Search places, get details, find nearby",
  },
  philipsHue: {
    schema: z.object({
      action: str("list|on|off|brightness|color|scene|discover"),
      bridgeIp: optStr("Hue bridge IP (env: HUE_BRIDGE_IP)"),
      apiKey: optStr("Hue API key (env: HUE_API_KEY)"),
      lightId: optStr("Light ID"),
      groupId: optStr("Group/room ID"),
      level: optNum("Brightness 0-254 (for brightness)"),
      hex: optStr("Hex color '#ff6600' (for color)"),
      hue: optNum("Hue 0-65535 (for color)"),
      sat: optNum("Saturation 0-254 (for color)"),
      bri: optNum("Brightness override (for color)"),
      colorTemp: optNum("Color temp 153-500 (for color)"),
      sceneId: optStr("Scene ID (for scene, omit to list scenes)"),
    }),
    description: "Control Philips Hue smart lights",
  },
  sonos: {
    schema: z.object({
      action: str("play|pause|stop|next|prev|volume|mute|queue|info"),
      speakerIp: optStr("Speaker IP (env: SONOS_SPEAKER_IP)"),
      level: optNum("Volume 0-100 (for volume, omit to get current)"),
      muted: optBool("Mute state (for mute, default: true)"),
      uri: optStr("Track URI (required for queue)"),
      title: optStr("Track title (for queue)"),
    }),
    description: "Control Sonos speakers",
  },
};

// Tools whose descriptions should include active channel names
const CHANNEL_AWARE_TOOLS = new Set(["messageChannel", "sendFile", "cron"]);

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
 * Get one-line description for a tool, enriched with runtime context.
 * @param {string} toolName
 * @param {object} [context] - { activeChannels: string[] }
 */
export function getToolDescription(toolName, context = {}) {
  const desc = toolSchemas[toolName]?.description;
  if (!desc) return null;
  if (CHANNEL_AWARE_TOOLS.has(toolName) && context.activeChannels?.length) {
    return `${desc} Connected channels: ${context.activeChannels.join(", ")}`;
  }
  return desc;
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
