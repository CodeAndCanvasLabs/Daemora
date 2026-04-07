---
name: coding-agent
description: Delegate complex coding tasks to external coding agents (Codex, Claude Code)
triggers: codex, claude code, coding agent, delegate coding, large refactor, big project
---

# Coding Agent Delegation

For large or complex coding tasks (50+ file changes, full-stack features, major refactors), delegate to a dedicated coding agent.

## When to Delegate

- Codebase-wide refactoring (rename patterns, migrate frameworks)
- Multi-file feature implementation (frontend + backend + tests)
- Bug hunting across large codebases
- Code review with automated fixes

## How to Delegate

Use `executeCommand` to spawn external coding agents as background processes:

### Claude Code
```
executeCommand({ command: "claude -p 'Your detailed task description here'", cwd: "/path/to/project", background: true })
```

### Codex CLI
```
executeCommand({ command: "codex 'Your task description'", cwd: "/path/to/project", background: true })
```

## Rules

- Include full context in the task description: what to change, why, constraints, files involved
- Set the correct `cwd` to the project root
- Run as background process — these tasks take minutes, not seconds
- Check output periodically via `executeCommand({ command: "cat /tmp/agent-output.log" })`
- After completion, verify changes with `gitTool({ action: "diff" })` and run tests
- Never delegate simple edits (single file, < 20 lines) — do those yourself
