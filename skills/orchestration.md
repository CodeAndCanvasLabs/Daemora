---
name: orchestration
description: Multi-agent orchestration - teams, parallel execution, delegation, swarm-style dependency resolution
triggers: parallel, orchestrate, sub-agent, project, plan, multiple tasks, frontend backend, coordinate, spawn, contract, full-stack, multi-step, team, teammates, priority, research, swarm
---

# Orchestration & Multi-Agent Planning

## Decision Matrix

### Do it yourself when:
- Single action: send email, quick search, toggle setting
- Direct iteration: "fix this line", "change that word"
- < 3 tool calls total

### Use useCrew when:
- Single focused task - research, build one file, analysis
- Fire-and-forget - spawn, collect result, move on

### Use parallelCrew when:
- Multiple INDEPENDENT tasks - no shared deliverable
- Never for tasks that share a project - use teamTask instead

### Use teamTask when:
- Multi-component project - frontend + backend, microservices, any "build X with Y"
- Dependent tasks where output of A feeds into B
- 3+ workers that need to coordinate via shared filesystem
- Full-stack builds, research pipelines, anything with phases

## teamTask (Swarm Pattern)

Code orchestrator spawns workers, passes completed results to dependent workers. No AI lead.

### How it works:
1. You define workers with tasks and `blockedByWorkers` dependencies
2. Independent workers spawn in parallel immediately
3. When a worker completes, its structured result (files, endpoints, ports) auto-injects into dependent workers' context
4. Dependent workers spawn once all their deps finish
5. Repeat until all done

### Creating a team:
```
teamTask({
  action: "createTeam",
  name: "todo-app",
  project: "todo-app",
  projectType: "coding",
  projectStack: "Node.js, React, SQLite",
  task: "Build a full-stack todo app with CRUD",
  workers: [
    {
      name: "backend",
      profile: "backend",
      task: "TASK: Build Express API with SQLite...\nFILES: /path/backend/...\nSPEC: GET/POST/PATCH/DELETE /api/todos...\nOUTPUT: Working API on port 3001"
    },
    {
      name: "frontend",
      profile: "frontend",
      task: "TASK: Build React UI with shadcn...\nFILES: /path/frontend/...\nOUTPUT: Working UI on port 5173",
      blockedByWorkers: ["backend"]
    },
    {
      name: "tester",
      profile: "tester",
      task: "TASK: Test CRUD flows end-to-end...\nOUTPUT: Test results",
      blockedByWorkers: ["backend", "frontend"]
    }
  ]
})
```

### Dependency flow (swarm handoff):
- backend completes → reports: endpoints, port, files created
- frontend spawns → gets backend's result in its context: "backend built GET /api/todos on port 3001"
- frontend completes → reports: files, components built
- tester spawns → gets both backend + frontend results in its context

### Other actions:
- `relaunchProject` - `{ teamId }` - resume incomplete team
- `status` - `{ teamId }` - check team state
- `listTeams` - all active teams
- `disbandTeam` - `{ teamId }` - stop a team

## Mandatory Structured Brief

Every worker task must include:

```
TASK: What to build/research/fix (one sentence)
CONTEXT: Background - what exists, what this connects to, why
FILES: Exact paths to create or modify
SPEC: Full contract - endpoints, schemas, interfaces
CONSTRAINTS: Frameworks, patterns, format requirements
OUTPUT: What to produce - files, report, test results
```

**Bad:** "Write the backend"
**Good:** "TASK: Build Express API with SQLite for todo CRUD. FILES: /project/backend/src/server.js, /project/backend/src/db.js. SPEC: GET /api/todos, POST /api/todos, PATCH /api/todos/:id, DELETE /api/todos/:id. JSON bodies. CORS for localhost:5173. CONSTRAINTS: Use better-sqlite3, zod validation. OUTPUT: Working API on port 3001."

## Parallel vs Sequential Decision
- Does task B need output from task A? → `blockedByWorkers: ["A"]` in teamTask
- Independent work? → parallelCrew or teamTask without blockedByWorkers (both run parallel)
- Same project, multiple parts? → teamTask always (shared filesystem + result handoff)

## Context Preservation
Spawn sub-agents to keep verbose output OUT of main context:
- Test suite output → sub-agent runs tests, returns summary only
- Log analysis → sub-agent reads logs, writes findings to file
- Large audit → sub-agent scans files, produces report

## Error Recovery
- Worker fails → team continues with other workers, reports failure in summary
- Relaunch → `relaunchProject` picks up where it left off, only runs incomplete workers
- Worker stuck → 30 min timeout, marked as failed automatically
