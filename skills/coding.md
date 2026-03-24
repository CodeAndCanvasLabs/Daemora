---
name: coding
description: Use when writing, debugging, or reviewing code
triggers: code, function, bug, error, refactor, implement, class, module, typescript, javascript, python, api, endpoint, test, debug, fix, PR, pull request, commit, git, push, pull, branch, merge, rebase, cherry-pick, stash, diff, log
---
## Workflow: Read → Understand → Change → Verify → Test

1. **Read** - readFile every file you'll touch. Check imports, patterns, conventions.
2. **Understand** - trace data flow. Find callers. Check tests.
3. **Change** - editFile for surgical fixes. writeFile only for new files or full rewrites.
4. **Verify** - readFile after every edit. Check the diff is what you intended.
5. **Test** - run build + tests. If they fail, fix and re-run. Don't finalize with failing tests.

## Rules

- In general, do not propose changes to code you haven't read. If you are asked about or want to modify a file, read it first. Understand existing code before suggesting modifications.
- Do not create files unless they're absolutely necessary for achieving your goal. Generally prefer editing an existing file to creating a new one, as this prevents file bloat and builds on existing work more effectively.
- Match existing code style (naming, indentation, patterns).
- Be careful not to introduce security vulnerabilities such as command injection, XSS, SQL injection, and other OWASP top 10 vulnerabilities. If you notice that you wrote insecure code, immediately fix it. Prioritize writing safe, secure, and correct code.

## Avoiding Over-Engineering

- Only make changes that are directly requested or clearly necessary. Keep solutions simple and focused.
- Don't add features, refactor code, or make "improvements" beyond what was asked. A bug fix doesn't need surrounding code cleaned up. A simple feature doesn't need extra configurability.
- Don't add docstrings, comments, or type annotations to code you didn't change. Only add comments where the logic isn't self-evident.
- Don't add error handling, fallbacks, or validation for scenarios that can't happen. Trust internal code and framework guarantees. Only validate at system boundaries (user input, external APIs).
- Don't use feature flags or backwards-compatibility shims when you can just change the code.
- Don't create helpers, utilities, or abstractions for one-time operations.
- Don't design for hypothetical future requirements. The right amount of complexity is the minimum needed for the current task - three similar lines of code is better than a premature abstraction.
- Avoid backwards-compatibility hacks like renaming unused _vars, re-exporting types, adding // removed comments for removed code, etc. If you are certain that something is unused, you can delete it completely.

## File Handling

- To read files use readFile - not cat, head, tail, or sed.
- To edit files use editFile - not sed or awk. editFile for surgical fixes (specific string replacement).
- To create files use writeFile - not cat with heredoc or echo redirection. writeFile only for new files or full rewrites.
- To search for files use listDirectory or glob - not find or ls.
- To search the content of files use grep or grep - not grep via shell.
- Always prefer editing existing files in the codebase. Never write new files unless explicitly required.
- When editing text, ensure you preserve the exact indentation (tabs/spaces) as it appears in the file.
- The edit will fail if the old string is not unique in the file. Either provide a larger string with more surrounding context to make it unique, or target every instance.

## Executing Actions With Care

- Carefully consider the reversibility and blast radius of actions.
- You can freely take local, reversible actions like editing files or running tests.
- For actions that are hard to reverse, affect shared systems beyond your local environment, or could otherwise be risky or destructive, check with the user before proceeding.
- If your approach is blocked, do not attempt to brute force your way to the outcome. Consider alternative approaches or other ways you might unblock yourself.
- When you encounter an obstacle, do not use destructive actions as a shortcut to simply make it go away. Try to identify root causes and fix underlying issues rather than bypassing safety checks.
- If you discover unexpected state like unfamiliar files, branches, or configuration, investigate before deleting or overwriting, as it may represent the user's in-progress work.

## Git Workflow

### Safety
- NEVER push without explicit user approval.
- NEVER run destructive git commands (push --force, reset --hard, checkout ., restore ., clean -f, branch -D) unless the user explicitly requests these actions. Taking unauthorized destructive actions is unhelpful and can result in lost work - only run these commands when given direct instructions.
- NEVER skip hooks (--no-verify, --no-gpg-sign, etc) unless the user explicitly requests it.
- NEVER run force push to main/master, warn the user if they request it.
- NEVER update the git config.
- Check current branch before committing - warn if on main/master.
- Never commit .env, credentials, or secrets. Do not commit files that likely contain secrets (.env, credentials.json, etc). Warn the user if they specifically request to commit those files.
- Before running destructive operations, consider whether there is a safer alternative that achieves the same goal. Only use destructive operations when they are truly the best approach.

### Commits
- ALWAYS create NEW commits rather than amending, unless the user explicitly requests a git amend.
- When a pre-commit hook fails, the commit did NOT happen - so --amend would modify the PREVIOUS commit, which may result in destroying work or losing previous changes. Instead, after hook failure, fix the issue, re-stage, and create a NEW commit.
- Run `git status` to see all untracked files. Never use the -uall flag as it can cause memory issues on large repos.
- Run `git diff` to see both staged and unstaged changes that will be committed.
- Run `git log` to see recent commit messages, so that you can follow this repository's commit message style.
- Stage specific files by name - avoid `git add .` or `git add -A` (can accidentally include sensitive files or large binaries).
- Commit message: summarize the nature of the changes (new feature, enhancement, bug fix, refactoring, test, docs). Ensure the message accurately reflects the changes and their purpose - "add" means a wholly new feature, "update" means an enhancement to an existing feature, "fix" means a bug fix.
- Draft a concise (1-2 sentences) commit message that focuses on the "why" rather than the "what".
- One logical change per commit. Don't batch unrelated work.
- ALWAYS pass the commit message via a HEREDOC for good formatting.
- If the commit fails due to pre-commit hook: fix the issue and create a NEW commit.
- If there are no changes to commit (no untracked files and no modifications), do not create an empty commit.
- NEVER use git commands with the -i flag (like git rebase -i or git add -i) since they require interactive input which is not supported.
- Do not use --no-edit with git rebase commands - --no-edit is not a valid option for git rebase.

### Branches
- Feature work → create a branch first. Don't commit directly to main.
- `git status` before switching branches - stash or commit dirty work.
- Pull before push - avoid conflicts.
- Prefer to create a new commit rather than amending an existing commit.

### Pull Requests
- Check if the current branch tracks a remote branch and is up to date with the remote, so you know if you need to push.
- Run `git log` and `git diff [base-branch]...HEAD` to understand the full commit history for the current branch (from the time it diverged from the base branch).
- Analyze ALL changes that will be included in the pull request - not just the latest commit, but ALL commits that will be included.
- Keep the PR title short (under 70 chars). Use the description/body for details, not the title.
- Push to remote with -u flag if needed.
- Create PR using `gh pr create`.
- Return the PR URL when done.
- Do NOT push to the remote repository unless the user explicitly asks to do so.

## Code Review
- Check for bugs, security issues, performance problems.
- Verify edge cases and error handling.
- Ensure tests cover the change.
- Flag over-engineering and unnecessary complexity.
