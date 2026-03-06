---
name: orchestration
description: Multi-agent orchestration, parallel execution, contract-based planning for complex multi-file tasks
triggers: parallel, orchestrate, sub-agent, project, plan, multiple tasks, frontend backend, coordinate, spawn, workspace, contract, full-stack, todo app, multi-step
---

# Orchestration & Multi-Agent Planning

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
Before spawning parallel agents, define the shared contract explicitly:
- API routes, request/response shapes, status codes
- Data models, field names, types
- File paths, component names, CSS class conventions
- Paste the ACTUAL contract text into `sharedContext` — don't reference it, include it.

## Always Pass Correct Working Directory
- Include the exact workspace path and project root in `sharedContext`.
- Never let agents guess where to create files — specify exact paths.

## Parallel vs Sequential Decision
- Does task B need output from task A? **Yes → sequential.** No → parallel.
- Parallel agents communicate through workspace files, NOT through messages or return values.
- Never run agents in parallel when they have data dependencies.

## Profile Guide
- **researcher**: gather info, browse web, write findings — no shell execution
- **coder**: read/write/run full loop — building, fixing, testing
- **writer**: produce documents and reports — no shell, no browser
- **analyst**: data processing with shell + web + vision
- No profile: default 27-tool set (safe general-purpose)
- Add `extraTools` when a profile is almost right but needs one more tool

## Workspace as Artifact Store
- `projectTracker` returns workspace path (`data/workspaces/{id}/`)
- Sub-agents write output files to workspace (code, reports, schemas)
- Parent reads from workspace to build context for next phase
- Artifacts survive crashes — work is never lost
- Do NOT pass full file contents as return values — write to workspace, return summary

## Structured Return Convention
End every sub-agent response with:
```
DONE: One sentence describing what was accomplished
FILES: workspace/path/file1.js, workspace/path/file2.md
CONTRACT: Key interfaces, exports, API endpoints produced
ERRORS: Any failures or caveats
```
Omit sections that don't apply.

## Writing Sub-Agent Task Descriptions
A sub-agent has NO context except what you give it. Write as if handing off to a developer with zero knowledge.

Include:
- Exact file path(s) to create or modify
- Full spec/schema/contract (paste actual names, endpoints, fields — don't summarize)
- Expected behavior and output
- Constraints (no external libraries, match existing patterns, specific format)

**Bad:** "Write the CSS file"
**Good:** "Create /project/style.css. Style these DOM elements: ul#todo-list, li.todo-item, button.delete-btn, input#new-todo. Requirements: CSS Grid layout, dark mode via prefers-color-scheme, smooth opacity transition on add/remove, mobile-first responsive (600px breakpoint). No frameworks."

## Sequential vs Parallel Agents
- **Sequential**: `spawnAgent` multiple times when each step needs previous output (research → write → test).
- **Parallel**: `parallelAgents` when steps can run simultaneously — always provide `sharedContext` with the shared contract.

## Model Routing for Cost
- Cheap tasks (research, summarization, boilerplate) → `"model":"openai:gpt-4.1-mini"` or `"model":"anthropic:claude-sonnet-4-20250514"`
- Expensive tasks (complex code, architecture, debugging) → default model or `"model":"anthropic:claude-opus-4-6"`
- Pass `"model"` in spawnAgent/parallelAgents options to override per-agent

## Steering Running Agents
- `manageAgents("steer")` with `{"agentId":"...", "message":"..."}` to redirect a running agent mid-task
- Use when you realize a sub-agent is going down the wrong path — cheaper than killing and respawning
- `manageAgents("list")` to see active agents and their status
- `manageAgents("kill")` with `{"agentId":"..."}` to stop a stuck agent

## Error Recovery
- Sub-agent fails → read its error from the return, diagnose root cause
- Transient failure (network, timeout) → respawn with same task description
- Logic failure (wrong approach) → respawn with corrected instructions + add what went wrong
- Never blindly retry — always adjust the task description based on the failure
- If multiple agents fail on the same issue → fix the shared contract/workspace, then respawn all
