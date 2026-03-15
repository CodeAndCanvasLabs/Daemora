---
name: orchestration
description: Multi-agent orchestration — sub-agents, teams, parallel execution, workspace collaboration, priority-based task ordering
triggers: parallel, orchestrate, sub-agent, project, plan, multiple tasks, frontend backend, coordinate, spawn, workspace, contract, full-stack, multi-step, team, teammates, competing hypotheses, debug, priority, research
---

# Orchestration & Multi-Agent Planning

## Decision Matrix

### Do it yourself when:
- Single action: send email, quick search, toggle setting
- Direct iteration: "fix this line", "change that word"
- < 3 tool calls total

### Use spawnAgent when:
- Single focused task — research, build one file, analysis
- Fire-and-forget — spawn, collect result, move on

### Use parallelAgents when:
- Multiple INDEPENDENT tasks — no data sharing needed
- Never for dependent tasks — use teamTask instead

### Use teamTask when:
- Dependent tasks (A→B→C) — agents share results via workspace
- 3+ interdependent tasks with priority ordering
- Competing hypotheses — multiple investigators, compare results
- Cross-layer coordination — frontend + backend + tests sharing contract

## 21 Agent Profiles

Pick the right profile — each has specialized tools, system prompt, and skill scope.

**Development:** `coder` · `architect` · `reviewer` · `tester` · `devops` · `security` · `database` · `frontend` · `api`
**Research:** `researcher` · `analyst` · `investigator`
**Content:** `writer` · `editor` · `translator`
**Business:** `planner` · `strategist` · `assistant`
**Operations:** `sysadmin` · `designer` · `coordinator`

Profile is REQUIRED — always specify one.

## Sub-Agent Patterns

### Sequential (dependent tasks)
```
result1 = spawnAgent(taskDescription: "Research API options...", profile: "researcher")
result2 = spawnAgent(taskDescription: "Build API based on: " + result1, profile: "coder")
result3 = spawnAgent(taskDescription: "Write tests for: " + result2, profile: "tester")
```

### Parallel (independent tasks)
```
parallelAgents(tasks: [
  {description: "Research competitor pricing...", profile: "researcher"},
  {description: "Audit security of auth module...", profile: "security"},
  {description: "Analyze usage metrics...", profile: "analyst"}
], sharedContext: "Project: SaaS platform, Q1 2026 review")
```

### MCP Specialist
```
useMCP("github", "Create issue titled 'Bug: login fails' with reproduction steps...")
```

## Team Patterns

### Basic team workflow
```
1. teamTask("createTeam", '{"name":"Feature Build"}')
2. teamTask("addTeammate", '{"teamId":"...","profile":"researcher","instructions":"Research auth patterns","id":"researcher"}')
3. teamTask("addTeammate", '{"teamId":"...","profile":"coder","instructions":"Implement auth system","id":"coder"}')
4. teamTask("addTeammate", '{"teamId":"...","profile":"tester","instructions":"Write auth tests","id":"tester"}')
5. teamTask("addTask", '{"teamId":"...","title":"Research auth","priority":"high"}')                    → taskId1
6. teamTask("addTask", '{"teamId":"...","title":"Implement auth","blockedBy":["taskId1"],"priority":"high"}') → taskId2
7. teamTask("addTask", '{"teamId":"...","title":"Write tests","blockedBy":["taskId2"],"priority":"medium"}')
8. teamTask("spawnAll", '{"teamId":"...","context":"Project root: /path/to/project"}')
9. teamTask("status", '{"teamId":"..."}')
10. teamTask("disband", '{"teamId":"..."}')
```

### Team workspace (shared context between agents)
Agents share findings via workspace — researcher stores, coder reads:
```
// Researcher stores findings
teamTask("storeContext", '{"teamId":"...","key":"auth-research","value":"JWT with RS256, refresh tokens...","author":"researcher"}')

// Coder reads researcher's findings
teamTask("readContext", '{"teamId":"...","key":"auth-research"}')

// Search workspace
teamTask("searchContext", '{"teamId":"...","query":"auth"}')

// List all workspace entries
teamTask("workspace", '{"teamId":"..."}')

// View team event history
teamTask("eventLog", '{"teamId":"..."}')
```

### Task priority
Tasks have priority: `critical` > `high` > `medium` > `low`
- `claimable` returns priority-sorted tasks — agents work on critical first
- `executionOrder` shows topological sort (deps + priority)

### Competing hypotheses (debugging)
```
teamTask("createTeam", '{"name":"Debug"}')
teamTask("addTeammate", '{"teamId":"...","profile":"coder","instructions":"Test hypothesis: bug in auth middleware","id":"hyp-auth"}')
teamTask("addTeammate", '{"teamId":"...","profile":"coder","instructions":"Test hypothesis: race condition in DB","id":"hyp-db"}')
teamTask("addTask", '{"teamId":"...","title":"Check auth middleware","priority":"high"}')
teamTask("addTask", '{"teamId":"...","title":"Check DB race conditions","priority":"high"}')
teamTask("spawnAll", '{"teamId":"..."}')
→ Both store findings in workspace. Read both, identify correct hypothesis, apply fix.
```

## Mandatory Structured Brief

Every spawn/teammate instruction must include:

```
TASK: What to build/research/fix (one sentence)
CONTEXT: Background — what exists, what this connects to, why
FILES: Exact paths to create or modify
SPEC: Full contract — endpoints, schemas, interfaces
CONSTRAINTS: Frameworks, patterns, format requirements
OUTPUT: What to produce — files, report, test results
```

**Bad:** "Write the CSS file"
**Good:** "TASK: Create stylesheet for todo app. FILES: /project/style.css. SPEC: CSS Grid layout, dark mode via prefers-color-scheme, mobile-first (600px breakpoint). CONSTRAINTS: Vanilla CSS only. OUTPUT: Single CSS file."

## Context Preservation
Spawn sub-agents to keep verbose output OUT of main context:
- Test suite output → sub-agent runs tests, returns summary only
- Log analysis → sub-agent reads logs, writes findings to file
- Large audit → sub-agent scans files, produces report
- Data processing → sub-agent processes, returns summary

## Parallel vs Sequential Decision
- Does task B need output from task A? **Yes → sequential** or **teamTask with blockedBy**.
- Independent work? → **parallelAgents**.
- Never run agents in parallel when they have data dependencies.

## Error Recovery
- Sub-agent fails → read error, diagnose root cause
- Transient failure → respawn with same task
- Logic failure → respawn with corrected instructions + what went wrong
- Team task fails → auto-releases back to pending for retry
- Teammate stuck → `teamTask("restart")` (max 3 restarts, auto-unclaims tasks)

## Steering Running Agents
- `manageAgents("steer", '{"agentId":"...","message":"..."}')` → redirect mid-task
- `teamTask("sendMessage", '{"teamId":"...","to":"...","message":"..."}')` → direct message
- `teamTask("broadcast", '{"teamId":"...","message":"..."}')` → message all
- `manageAgents("kill", '{"agentId":"..."}')` → stop stuck agent

## Model Routing for Cost
- Cheap tasks (research, summarization) → `model: "openai:gpt-4.1-mini"`
- Expensive tasks (complex code, architecture) → default model or `model: "anthropic:claude-sonnet-4-20250514"`
- Pass `model` in spawnAgent options to override per-agent
