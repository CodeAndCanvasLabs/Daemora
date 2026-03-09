---
name: orchestration
description: Multi-agent orchestration — sub-agents, teams, parallel execution, contract-based planning, workspace artifacts, coordination patterns
triggers: parallel, orchestrate, sub-agent, project, plan, multiple tasks, frontend backend, coordinate, spawn, workspace, contract, full-stack, todo app, multi-step, team, teammates, competing hypotheses, debug
---

# Orchestration & Multi-Agent Planning

## Decision Matrix: Sub-agents vs Teams

### Use sub-agents (spawnAgent/parallelAgents) when:
- Single focused task — research, build one file, run analysis
- MCP delegation — each MCP server already has a specialist via `useMCP`
- Context isolation — keep verbose output out of main context
- Independent parallel work — no data sharing needed between agents
- Fire-and-forget — spawn, collect result, move on

### Use teams (teamTask) when:
- 3+ interdependent tasks — agents need to share results via messaging
- Claim/lock mechanics needed — prevent duplicate work on shared task list
- Competing hypotheses — multiple investigators testing different theories
- Cross-layer coordination — frontend + backend + tests sharing a contract
- Long-running coordinated work — agents communicate mid-execution

## Sub-Agent Patterns

### Sequential (dependent tasks)
```
result1 = spawnAgent("Research API options", {profile:"researcher"})
result2 = spawnAgent("Build API based on research: " + result1, {profile:"coder"})
result3 = spawnAgent("Write tests for API: " + result2, {profile:"coder"})
```

### Parallel (independent tasks)
```
parallelAgents([
  {description:"Build index.html with id=app, ul#todo-list, li.todo-item", options:{profile:"coder"}},
  {description:"Build style.css for .todo-item, .delete-btn, #new-todo", options:{profile:"coder"}},
  {description:"Build app.js — event listeners, DOM manipulation, localStorage", options:{profile:"coder"}}
], {sharedContext:"Contract: HTML uses id=app, ul#todo-list, li.todo-item, button.delete-btn, input#new-todo. CSS classes: .completed, .editing. JS exports: addTodo(), deleteTodo(), toggleTodo()."})
```

### MCP Specialist
```
useMCP("github", "Create a new issue in repo owner/repo titled 'Bug: login fails' with body describing the steps to reproduce...")
```

## Team Patterns

### Basic team workflow
```
1. teamTask("createTeam", '{"name":"Feature Build"}')           → returns teamId
2. teamTask("addTeammate", '{"teamId":"...","profile":"coder","instructions":"Build the React components","id":"frontend"}')
3. teamTask("addTeammate", '{"teamId":"...","profile":"coder","instructions":"Build the API endpoints","id":"backend"}')
4. teamTask("addTask", '{"teamId":"...","title":"Build API routes","description":"Create /api/users CRUD endpoints..."}')
5. teamTask("addTask", '{"teamId":"...","title":"Build React components","description":"Create UserList, UserForm...","blockedBy":["<api-task-id>"]}')
6. teamTask("spawnAll", '{"teamId":"...","context":"Workspace: /path/to/workspace"}')
7. teamTask("status", '{"teamId":"..."}')                       → monitor progress
8. teamTask("readMail", '{"teamId":"..."}')                     → check teammate messages
9. teamTask("disband", '{"teamId":"..."}')                      → cleanup when done
```

### Competing hypotheses (debugging)
```
1. teamTask("createTeam", '{"name":"Debug Investigation"}')
2. teamTask("addTeammate", '{"teamId":"...","profile":"coder","instructions":"Investigate hypothesis: the bug is in the auth middleware. Check token validation logic.","id":"hyp-auth"}')
3. teamTask("addTeammate", '{"teamId":"...","profile":"coder","instructions":"Investigate hypothesis: the bug is in the database query. Check for race conditions.","id":"hyp-db"}')
4. teamTask("addTask", '{"teamId":"...","title":"Investigate auth middleware"}')
5. teamTask("addTask", '{"teamId":"...","title":"Investigate database queries"}')
6. teamTask("spawnAll", '{"teamId":"..."}')
→ Read results from both, identify which hypothesis was correct, apply the fix.
```

## When to Plan vs Just Do It
- Simple task (1-2 files, single clear action) → do it directly, no planning overhead.
- Heavy task (3+ files, multi-agent, research-then-build, unclear scope) → plan first with projectTracker, then execute.

## Planning Workflow
1. `projectTracker("createProject")` — breaks work into tasks, creates shared workspace directory.
2. Pass returned workspace path in `sharedContext` so all sub-agents write artifacts there.
3. Define the **shared contract** (API schema, DOM structure, naming conventions) BEFORE spawning agents.
4. Mark each task `in_progress` before starting, `done` with notes when finished.
5. If interrupted → `projectTracker("listProjects")` to find and resume.

## Contract-Based Pattern
Before spawning parallel agents or teams, define the shared contract explicitly:
- API routes, request/response shapes, status codes
- Data models, field names, types
- File paths, component names, CSS class conventions
- Paste the ACTUAL contract text into `sharedContext` — don't reference it, include it.

## Mandatory Structured Brief
Every spawn/teammate instruction must include:

```
TASK: What to build/research/fix (one sentence)
CONTEXT: Background — what exists, what this connects to, why
FILES: Exact paths to create or modify
SPEC: Full contract — endpoints, schemas, interfaces, DOM structure
CONSTRAINTS: No frameworks, match existing patterns, specific format, etc.
OUTPUT: What to produce — files, report, test results
```

**Bad:** "Write the CSS file"
**Good:** "TASK: Create the stylesheet for the todo app. CONTEXT: HTML uses ul#todo-list, li.todo-item, button.delete-btn, input#new-todo. FILES: /project/style.css. SPEC: CSS Grid layout, dark mode via prefers-color-scheme, smooth opacity transition on add/remove, mobile-first responsive (600px breakpoint). CONSTRAINTS: No frameworks, vanilla CSS only. OUTPUT: Single CSS file, all elements styled."

## Structured Return Convention
End every sub-agent/teammate response with:
```
DONE: One sentence describing what was accomplished
FILES: workspace/path/file1.js, workspace/path/file2.md
CONTRACT: Key interfaces, exports, API endpoints produced
ERRORS: Any failures or caveats
```
Omit sections that don't apply.

## Profile Guide
- **researcher**: gather info, browse web, write findings — no shell execution
- **coder**: read/write/run full loop — building, fixing, testing
- **writer**: produce documents and reports — no shell, no browser
- **analyst**: data processing with shell + web + vision
- No profile: default 27-tool set (safe general-purpose)
- Add `extraTools` when a profile is almost right but needs one more tool

## Model Routing for Cost
- Cheap tasks (research, summarization, boilerplate) → `"model":"openai:gpt-4.1-mini"` or `"model":"anthropic:claude-sonnet-4-20250514"`
- Expensive tasks (complex code, architecture, debugging) → default model or `"model":"anthropic:claude-opus-4-6"`
- Pass `"model"` in spawnAgent/parallelAgents options to override per-agent

## Context Preservation
Spawn sub-agents to keep verbose output OUT of main context:
- Test suite output → sub-agent runs tests, returns only summary + failure details
- Log analysis → sub-agent reads logs, writes findings to workspace file
- Large codebase audit → sub-agent scans files, produces report
- Data processing → sub-agent processes, writes results, returns summary

## Workspace as Artifact Store
- `projectTracker` returns workspace path (`data/workspaces/{id}/`)
- Sub-agents write output files to workspace (code, reports, schemas)
- Parent reads from workspace to build context for next phase
- Artifacts survive crashes — work is never lost
- Do NOT pass full file contents as return values — write to workspace, return summary

## Always Pass Correct Working Directory
- Include the exact workspace path and project root in `sharedContext`.
- Never let agents guess where to create files — specify exact paths.

## Parallel vs Sequential Decision
- Does task B need output from task A? **Yes → sequential.** No → parallel.
- Parallel agents communicate through workspace files, NOT through messages or return values.
- Never run agents in parallel when they have data dependencies.
- For teams: use `blockedBy` deps in addTask to enforce ordering automatically.

## Steering Running Agents
- `manageAgents("steer")` with `{"agentId":"...", "message":"..."}` to redirect a running agent mid-task
- For teams: `teamTask("sendMessage")` or `teamTask("broadcast")` — injected via steerQueue immediately
- `manageAgents("list")` to see active agents and their status
- `manageAgents("kill")` with `{"agentId":"..."}` to stop a stuck agent

## Error Recovery
- Sub-agent fails → read its error from the return, diagnose root cause
- Transient failure (network, timeout) → respawn with same task description
- Logic failure (wrong approach) → respawn with corrected instructions + add what went wrong
- Never blindly retry — always adjust the task description based on the failure
- If multiple agents fail on the same issue → fix the shared contract/workspace, then respawn all
- Team task fails → it auto-releases back to pending for retry by another teammate
