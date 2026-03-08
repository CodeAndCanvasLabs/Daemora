---
name: planning
description: Task planning and implementation design — decide when to plan vs just do, break complex tasks into steps, explore before building
triggers: plan, planning, design, architect, approach, strategy, implement, big task, complex task, multi-step, think through, break down, figure out, how should, what approach
---

# Planning — Think Before You Build

## When to Plan vs Just Do It

**Plan first** when ANY of these apply:
- **New feature** — adding meaningful new functionality. Where does it go? What are the edge cases?
- **Multiple valid approaches** — the task can be solved in several ways. Pick the right one before writing code.
- **Code modifications** — changes that affect existing behavior or structure. Understand what exists first.
- **Architectural decisions** — choosing between patterns, libraries, data models, or technologies.
- **Multi-file changes** — the task will touch 3+ files. Map out which files and what changes.
- **Unclear scope** — you need to explore before understanding the full extent of work.
- **User preferences matter** — the implementation could go multiple reasonable directions.

**Skip planning** — do it directly:
- Single-line or few-line fixes (typos, obvious bugs, small tweaks).
- Adding a single function with clear requirements.
- Tasks where the user gave very specific, detailed instructions.
- Pure research or exploration (just search and read).

**When in doubt → plan.** The cost of planning is low. The cost of rework is high.

## Planning Workflow

1. **Explore first** — read the relevant files. Understand existing patterns, conventions, architecture. Use `searchFiles`, `searchContent`, `readFile`, `glob`, `grep` to map the codebase.
2. **Identify the approach** — what files to create/modify, what patterns to follow, what the data flow looks like. Consider alternatives and pick the best one.
3. **Break into steps** — ordered list of concrete actions. Each step = one verifiable outcome. Keep it short — a list of actions, not an essay.
4. **Track with projectTracker** — for complex multi-step work, use `projectTracker("createProject")` to persist the plan. Mark tasks `in_progress` → `done` as you go.
5. **Execute step by step** — work through each step. Verify after each one. If 3+ steps in and something doesn't add up, stop and re-assess.

## How to Explore

Before planning, gather enough context:
- **Find files** — `glob("src/**/*.ts")`, `searchFiles("*.controller.*")` to map the structure.
- **Find patterns** — `searchContent("export function", "src/")`, `grep("interface.*Props")` to see conventions.
- **Read key files** — entry points, related components, tests, configs. Understand the existing architecture.
- **Check dependencies** — what libraries are used, what APIs exist, what patterns are established.

Don't explore forever. 3-5 targeted reads is usually enough. Get the lay of the land, then plan.

## What a Good Plan Looks Like

A plan is a short ordered list of concrete actions:
```
1. Add `FooService` class in src/services/foo.ts — handles X with methods Y, Z
2. Update src/routes/api.ts — add GET /api/foo endpoint, wire to FooService
3. Add tests in tests/foo.test.ts — cover happy path + error cases
4. Update src/types.ts — add FooConfig interface
```

NOT:
```
First, I'll think about the architecture. Then I'll consider the patterns.
After that, I'll design the data model. Finally, I'll implement everything.
```

Each step should be specific enough that you could hand it to another developer with zero context.

## Planning Multi-Agent Work

For tasks requiring multiple agents, plan the coordination before spawning:
1. Define the **shared contract** — API shapes, file paths, naming conventions, data models.
2. Decide **parallel vs sequential** — does agent B need output from agent A? Yes → sequential. No → parallel.
3. Assign **profiles** — coder for code, researcher for research, writer for docs, analyst for data.
4. Write **complete briefs** — each sub-agent has zero context beyond what you give it.
5. Load `readFile("skills/orchestration.md")` for full multi-agent patterns.

## Re-Assessment

If you're 3+ steps into execution and:
- The approach isn't working as expected
- You discovered something that changes the requirements
- The scope is larger than initially estimated

**Stop. Re-read the original request. Re-plan from current state.** Don't push through a broken plan.

## Planning Checklist

Before starting execution, verify:
- [ ] Read all relevant files in the change area
- [ ] Understood existing patterns and conventions
- [ ] Identified all files that need changes
- [ ] Considered edge cases and error handling
- [ ] Steps are ordered (dependencies resolved)
- [ ] Each step has a clear, verifiable outcome
