# Agents & Teams

Daemora uses a multi-agent architecture where the main agent orchestrates specialized sub-agents and teams.

## Agent Types

### Main Agent
The primary agent that receives user messages. Has 22 core tools and orchestrates work by spawning sub-agents.

**Core tools:** File I/O (readFile, writeFile, editFile, listDirectory, glob, grep, applyPatch), Shell (executeCommand), Web (webFetch, webSearch), Memory (readMemory, writeMemory, searchMemory), Orchestration (spawnAgent, parallelAgents, manageAgents, teamTask, discoverProfiles), Communication (replyToUser), Tasks (taskManager, cron), MCP (useMCP).

### Sub-Agents
Specialized agents spawned by the main agent for focused tasks. Each has a profile that defines its tools, identity, and skill scope.

Sub-agents do NOT have orchestration tools — they execute, they don't delegate.

### Team Members
Sub-agents spawned as part of a team. They have teamTask for claiming/completing tasks and inter-agent messaging, but no orchestration tools.

## Profiles

22 built-in profiles organized by category:

**Development:** coder, architect, reviewer, tester, devops, security, database, frontend, api

**Research:** researcher, analyst, investigator

**Content:** writer, editor, translator

**Business:** planner, strategist, assistant

**Operations:** sysadmin, designer, coordinator, meeting-attendant

Each profile defines:
- **System prompt** — role-specific instructions
- **Tools** — scoped tool set (e.g. coder gets executeCommand, researcher gets webSearch)
- **Skills** — include/exclude skill categories
- **Model** — optional model override
- **Temperature** — creativity level

### Profile Discovery

The main agent uses `discoverProfiles` to find the right profile:

```
User: "Create Jira tickets for these bugs"

Main agent: discoverProfiles("create jira tickets")
→ Returns: [{id: "planner", score: 0.8}, {id: "coordinator", score: 0.6}]

Main agent: spawnAgent("Create Jira tickets for...", profile: "planner")
```

If a profile's plugin is disabled for the tenant, `discoverProfiles` returns a "not enabled" message.

## Spawning Sub-Agents

### Single Task
```
spawnAgent(taskDescription: "Research AI trends in 2026", profile: "researcher")
```

### Multiple Independent Tasks
```
parallelAgents(tasks: [
  {description: "Research competitors", profile: "researcher"},
  {description: "Audit security", profile: "security"},
  {description: "Analyze metrics", profile: "analyst"}
], sharedContext: "Project: Acme Corp")
```

### Team Workflow (Interdependent Tasks)
```
teamTask(action: "createTeam", name: "Feature Build")
teamTask(action: "addTeammate", teamId, profile: "researcher", instructions: "...")
teamTask(action: "addTeammate", teamId, profile: "coder", instructions: "...")
teamTask(action: "addTask", teamId, title: "Research", priority: "high")
teamTask(action: "addTask", teamId, title: "Implement", blockedBy: ["<researchTaskId>"])
teamTask(action: "spawnAll", teamId, context: "Build user auth feature")
```

## Tool Access Rules

| Tool | Main Agent | Sub-Agent | Team Member |
|------|-----------|-----------|-------------|
| spawnAgent | Yes | No | No |
| parallelAgents | Yes | No | No |
| teamTask | Yes | No | Yes (claim/complete/mail) |
| manageAgents | Yes | No | No |
| discoverProfiles | Yes | No | No |
| delegateToAgent | Yes | No | No |
| manageMCP | Yes | No | No |
| useMCP | Yes | Yes | Yes |
| Work tools | Core only (22) | Profile-scoped | Profile-scoped |

## Context Management

- **Main agent context:** ~5K tokens for tools (22 core tools). Lean and focused.
- **Sub-agent context:** ~400-600 tokens. Profile identity + 10 rules + scoped skills. No SOUL.md.
- **Task produces raw data** → spawn sub-agent (one-shot, keeps main agent context clean)
- **Need previous context** → reuse the same session ID
- **Simple task** → main agent handles directly, no spawn

## Team Features

- **Shared task list** — tasks with status, priority, blockedBy dependencies
- **Pre-assigned tasks** — main agent assigns specific tasks to specific teammates
- **Claim pool** — unassigned tasks can be claimed by any available teammate
- **Mailbox** — inter-agent messaging (sendMessage, broadcast, readMail)
- **Workspace** — shared key-value store for context (storeContext, readContext, searchContext)
- **Event log** — team activity history
- **Max limits** — 5 teams, 10 teammates per team, 7 concurrent sub-agents, depth 3
