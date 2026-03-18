# Tools

Daemora has 46 built-in tools + plugin tools. The main agent gets 22 core tools; specialized tools are available through sub-agent profiles.

## Core Tools (Main Agent)

Always available to the main agent:

| Category | Tools |
|----------|-------|
| **File I/O** | readFile, writeFile, editFile, listDirectory, glob, grep, applyPatch |
| **Shell** | executeCommand |
| **Web** | webFetch, webSearch |
| **Memory** | readMemory, writeMemory, searchMemory |
| **Orchestration** | spawnAgent, parallelAgents, manageAgents, teamTask, discoverProfiles |
| **Communication** | replyToUser |
| **Tasks** | taskManager, cron |
| **MCP** | useMCP |

## Profile Tools (Sub-Agents)

Available through sub-agent profiles:

| Tool | Profiles | Description |
|------|----------|-------------|
| browserAction | coder, researcher | Playwright browser automation |
| imageAnalysis | coder, researcher, designer | Vision model image analysis |
| screenCapture | coder | Screenshot/video capture |
| generateImage | designer | DALL-E image generation |
| readPDF | writer, researcher | Extract text from PDF |
| createDocument | writer, researcher | Create markdown/PDF/DOCX |
| sendEmail | assistant | Send email via SMTP/Resend |
| messageChannel | coordinator | Cross-channel messaging |
| sendFile | assistant | Send files to users |
| replyWithFile | assistant | Reply with file attachment |
| transcribeAudio | assistant | Audio to text (Whisper) |
| textToSpeech | assistant | Text to audio (TTS) |
| makeVoiceCall | meeting-attendant | Outbound voice calls (Twilio) |
| meetingAction | meeting-attendant | Join meetings via phone dial-in |
| gitTool | coder, devops | Git operations |
| clipboard | coder | System clipboard access |
| readDailyLog | assistant | Read daily activity log |
| writeDailyLog | assistant | Write to daily log |
| pruneMemory | sysadmin | Remove old memory entries |
| listMemoryCategories | sysadmin | List memory categories |
| projectTracker | coder | Track sub-tasks |
| manageMCP | sysadmin | Manage MCP servers |
| delegateToAgent | — | A2A protocol delegation |
| reload | sysadmin | Hot-reload system components |

## Plugin Tools

Available through bundled or installed plugins:

| Plugin | Tools | Required Keys |
|--------|-------|---------------|
| Google Services | calendar, contacts, googlePlaces | Calendar API Key, Places API Key |
| Smart Home | philipsHue, sonos | Hue Bridge IP + API Key |
| Notifications | notification | ntfy URL |
| iMessage | iMessageTool | None (macOS only) |
| SSH Remote | sshTool | SSH Host |
| Database | database | PostgreSQL/MySQL URL |

## Tool Descriptions

### File Tools
- **readFile** — Read file contents with optional offset/limit
- **writeFile** — Create or overwrite a file
- **editFile** — Find-and-replace edit in a file
- **listDirectory** — List files and folders with types/sizes
- **glob** — Find files on disk by glob pattern, sorted by recently modified
- **grep** — Regex search inside files on disk with context lines (like ripgrep)
- **applyPatch** — Apply diff patch to a file (unified or V4A format)

### System Tools
- **executeCommand** — Run any shell command

### Web Tools
- **webFetch** — Fetch web URL content as text (cached 15m)
- **webSearch** — Search the web (DuckDuckGo/Brave)
- **browserAction** — Playwright browser automation with snapshots

### Communication Tools
- **sendEmail** — Send email via SMTP or Resend API
- **messageChannel** — Send message to any active channel
- **replyToUser** — Send text to current user mid-task
- **makeVoiceCall** — Outbound voice calls via Twilio
- **meetingAction** — Join meetings via phone dial-in (Twilio + OpenAI Realtime STT + TTS)

### Memory Tools
- **readMemory** — Read persistent MEMORY.md
- **writeMemory** — Save entry to persistent memory
- **searchMemory** — Search memory and daily logs (semantic + keyword)

### AI Tools
- **imageAnalysis** — Analyze images with vision model
- **generateImage** — Generate images with DALL-E
- **transcribeAudio** — Audio to text via Whisper
- **textToSpeech** — Text to audio MP3

### Orchestration Tools
- **spawnAgent** — Spawn specialist sub-agent with profile
- **parallelAgents** — Run multiple sub-agents simultaneously
- **teamTask** — Create teams, manage shared tasks, inter-agent messaging
- **discoverProfiles** — Find the right sub-agent profile for a task
- **manageAgents** — List/kill running sub-agents
