---
name: coding
description: Use when writing, debugging, or reviewing code
triggers: code, function, bug, error, refactor, implement, class, module, typescript, javascript, python, api, endpoint, test, debug, fix, PR, pull request, commit, git
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
- Read the diff before committing: `git diff`
- Write clear commit messages: imperative, present tense, explain WHY
- One logical change per commit

## Code Review
- Check for bugs, security issues, performance problems
- Verify edge cases and error handling
- Ensure tests cover the change
- Flag over-engineering and unnecessary complexity
