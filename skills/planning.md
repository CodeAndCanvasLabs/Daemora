---
name: planning
description: Task planning for any complex work — coding, research, communication, automation. Decide when to plan vs just do, break into steps, get user confirmation before executing.
triggers: plan, planning, design, architect, approach, strategy, implement, big task, complex task, multi-step, think through, break down, figure out, how should, what approach, steps, workflow
---

# Planning — Think Before You Act

## When to Plan vs Just Do It

**Plan first** when ANY of these apply:
- **Multiple steps required** — the task needs 3+ distinct actions to complete.
- **Multiple valid approaches** — the task can be solved several ways. Pick the right one first.
- **Unclear scope** — you need to explore or research before understanding the full extent of work.
- **User preferences matter** — the outcome could go multiple reasonable directions.
- **High stakes** — mistakes are costly to undo (emails sent, files restructured, data transformed).
- **Multi-agent work** — the task needs parallel or sequential agent coordination.
- **New feature or system change** — adding meaningful new functionality or modifying existing behavior.
- **Multi-file code changes** — the task will touch 3+ files. Map out which files and what changes.
- **Architectural decisions** — choosing between patterns, libraries, data models, or technologies.

**Skip planning** — do it directly:
- Single-action tasks (send one email, fetch one page, fix a typo).
- Tasks where the user gave very specific, detailed instructions.
- Quick lookups, simple questions, casual conversation.
- Few-line code fixes with obvious solutions.

**When in doubt → plan.** The cost of planning is low. The cost of rework is high.

## Planning Workflow

1. **Explore** — gather context. Read files, search the web, check memory, review conversation history. Understand the current state before deciding what to change.
2. **Identify the approach** — what needs to happen, in what order, using what tools/agents. Consider alternatives and pick the best one.
3. **Break into steps** — ordered list of concrete actions. Each step = one verifiable outcome. Keep it short — a list of actions, not an essay.
4. **Present the plan to the user** — before executing, tell the user what you're about to do and ask for confirmation. This prevents wasted effort and ensures alignment. Format: numbered list of concrete actions, not vague descriptions.
5. **Execute on confirmation** — work through each step. Verify after each one.

## User Confirmation

**Always confirm before executing a complex plan.** Present the plan clearly and ask:
- "Here's my plan — want me to go ahead?"
- List the concrete steps so the user can see what will happen.
- If the user adjusts, update the plan and confirm again.
- Only skip confirmation for simple tasks that don't need planning.

This is non-negotiable for complex work. The user should always know what's about to happen before it happens.

## Exploration by Task Type

**Code tasks:**
- Find files — `glob("src/**/*.ts")`, `searchFiles("*.controller.*")` to map the structure.
- Find patterns — `grep("export function", "src/")`, `grep("interface.*Props")` to see conventions.
- Read key files — entry points, related components, tests, configs.
- Check dependencies — what libraries, APIs, patterns are established.

**Research tasks:**
- Web search for current information on the topic.
- Fetch and read actual pages — don't stop at summaries.
- Check memory for previous findings on the same topic.
- Cross-reference multiple sources for anything important.

**Communication tasks:**
- Review conversation history for context and tone.
- Check memory for user preferences (writing style, contacts, templates).
- Identify all recipients, attachments, and follow-up actions needed.

**Automation / workflow tasks:**
- Map the full workflow end-to-end before automating any step.
- Identify dependencies between steps.
- Check what tools, APIs, and MCP servers are available.

3-5 targeted explorations is usually enough. Get the lay of the land, then plan.

## What a Good Plan Looks Like

A plan is a short ordered list of concrete actions:

**Coding example:**
```
1. Add FooService class in src/services/foo.ts — handles X with methods Y, Z
2. Update src/routes/api.ts — add GET /api/foo endpoint, wire to FooService
3. Add tests in tests/foo.test.ts — cover happy path + error cases
4. Run build + tests, fix any failures
```

**Research example:**
```
1. Search web for latest pricing on X, Y, Z services
2. Fetch each provider's pricing page, extract plan details
3. Compare features and costs in a structured table
4. Save findings to memory for future reference
```

**Workflow example:**
```
1. Fetch all invoices from email (last 30 days)
2. Extract amounts, dates, vendors from each
3. Create summary spreadsheet in workspace
4. Send summary to user via email
```

NOT:
```
First, I'll think about what to do. Then I'll consider the options.
After that, I'll figure out the best approach. Finally, I'll do everything.
```

Each step should be specific enough to hand to someone with zero context.

## Planning Multi-Agent Work

Any task that spawns agents — `spawnAgent`, `parallelAgents`, `useMCP` — is multi-agent work. MCP tasks are spawned agent tasks. Plan them the same way.

### Agent Isolation — Non-Negotiable
- Each agent operates in its own context. No shared memory, no shared state, no implicit communication.
- Agents must NOT touch files, paths, or resources owned by another agent. Define boundaries upfront.
- If two agents need the same data, pass it explicitly via `sharedContext` or workspace files. Never assume one agent can read another's output unless the plan says so.
- MCP agents (`useMCP`) get ONLY that server's tools. They cannot access files, shell, or other MCP servers. Plan accordingly — don't expect an MCP agent to do something outside its server's scope.

### Contract-Based Planning
Before spawning any agents, define the contract:
1. **Inputs** — what each agent receives. Exact data, file paths, specs. Paste the actual content into the brief — don't reference it.
2. **Outputs** — what each agent produces. File paths, data shapes, expected format.
3. **Boundaries** — what each agent is NOT allowed to touch. Files, directories, APIs outside its scope.
4. **Dependencies** — does agent B need output from agent A? Yes → sequential. No → parallel.
5. **Profiles** — coder for code, researcher for research, writer for docs, analyst for data.

### MCP as Spawned Agents
- `useMCP(serverName, taskDescription)` spawns a specialist agent with ONLY that MCP server's tools.
- The specialist has ZERO context beyond the task description you write. Include everything: what to do, all details, full content, background context.
- Plan MCP calls like any other agent spawn — define inputs, expected outputs, and what happens with the result.
- Multiple MCP calls to different servers can run in parallel if they don't depend on each other.

### Preventing Cross-Agent Impact
- Never let two agents write to the same file. Split by file or by section with clear ownership.
- Never let an agent modify global state (env vars, configs, databases) without the plan explicitly calling for it.
- Use workspace directories (`data/workspaces/{id}/`) as artifact stores. Each agent writes to its own path within the workspace.
- After all agents finish, the parent synthesizes results. Agents never directly consume each other's output during execution.

Load `readFile("skills/orchestration.md")` for full multi-agent coordination patterns, error recovery, and structured return conventions.

## Tracking Complex Work

For multi-step work, use `projectTracker("createProject")` to persist the plan:
- Mark tasks `in_progress` before starting, `done` with notes when finished.
- If interrupted → `projectTracker("listProjects")` to find and resume.
- Workspace files survive crashes — work is never lost.

## Re-Assessment

If you're 3+ steps into execution and:
- The approach isn't working as expected
- You discovered something that changes the requirements
- The scope is larger than initially estimated

**Stop. Re-read the original request. Re-plan from current state.** Don't push through a broken plan. If the new plan differs significantly, confirm with the user again.

## Planning Checklist

Before executing, verify:
- [ ] Gathered enough context (files, web, memory, conversation)
- [ ] Identified the best approach from available options
- [ ] Steps are ordered (dependencies resolved)
- [ ] Each step has a clear, verifiable outcome
- [ ] User has confirmed the plan (for complex work)
- [ ] Edge cases and potential failures considered
- [ ] Multi-agent tasks: contracts defined, boundaries set, no shared-file conflicts
- [ ] MCP tasks: task descriptions are self-contained, expected outputs specified
