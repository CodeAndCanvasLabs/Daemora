---
name: coding
description: Use when writing, debugging, or reviewing code
triggers: code, function, bug, error, refactor, implement, class, module, typescript, javascript, python, api, endpoint, test, debug, fix, PR, pull request, commit, git, push, pull, branch, merge, rebase, cherry-pick, stash, diff, log
---
## Workflow: Read → Understand → Change → Verify → Test

1. **Read** — readFile every file you'll touch. Check imports, patterns, conventions.
2. **Understand** — trace data flow. Find callers. Check tests.
3. **Change** — editFile for surgical fixes. writeFile only for new files or full rewrites.
4. **Verify** — readFile after every edit. Check the diff is what you intended.
5. **Test** — run build + tests. If they fail, fix and re-run. Don't finalize with failing tests.

## Rules
- Match existing code style (naming, indentation, patterns)
- Don't add comments, docstrings, or type annotations to code you didn't change
- Don't refactor code you weren't asked to refactor
- Don't add error handling for impossible scenarios
- Security: no injection, XSS, hardcoded secrets, path traversal

## Git Workflow

### Safety
- Never push without explicit user approval.
- Never force push. Never `reset --hard` without asking.
- Check current branch before committing — warn if on main/master.
- Never commit .env, credentials, or secrets.

### Commits
- `git diff` — review all changes before staging.
- Stage specific files — avoid `git add .` (catches unwanted files).
- Commit message: imperative, present tense, explain WHY not WHAT.
- One logical change per commit. Don't batch unrelated work.

### Branches
- Feature work → create a branch first. Don't commit directly to main.
- `git status` before switching branches — stash or commit dirty work.
- Pull before push — avoid conflicts.

### Pull Requests
- Title: short (<70 chars). Body: what changed and why.
- Reference related issues if applicable.
- Run tests before creating PR.

## Code Review
- Check for bugs, security issues, performance problems
- Verify edge cases and error handling
- Ensure tests cover the change
- Flag over-engineering and unnecessary complexity
