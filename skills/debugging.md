---
name: debugging
description: Systematic debugging - reproduce, isolate, fix, verify
triggers: debug, error, crash, stack trace, traceback, exception, failing, broken, not working, undefined, null, segfault, panic, hang, freeze
---
## Workflow: Reproduce → Isolate → Fix → Verify

1. **Reproduce** - run the failing command/test. Get the exact error message + stack trace.
2. **Isolate** - trace the error to its source:
   - Read the stack trace bottom-up (most recent call first)
   - `grep` for the error message or failing function
   - Check recent changes: `git log --oneline -10` then `git diff HEAD~3`
   - Add logging if the cause isn't obvious
3. **Fix** - make the minimal change that fixes the root cause (not the symptom)
4. **Verify** - run the original failing command. Confirm it passes. Run full test suite.

## Error Reading Patterns
- `TypeError: X is not a function` → wrong import, typo, or undefined variable
- `Cannot read property of undefined` → null check missing or wrong data path
- `ENOENT` → file/directory doesn't exist
- `EACCES` → permission issue
- `ECONNREFUSED` → service not running
- `Module not found` → missing dependency or wrong import path
- `SyntaxError` → check the exact line number, often a missing bracket or comma

## Binary Search for Bugs
- If you can't find the cause, `git bisect` or manually check: does it work in commit X? In commit Y? Narrow down.
- For runtime bugs: add console.log at function entry/exit to trace execution flow.

## Don't
- Don't guess - reproduce first
- Don't add try/catch to hide errors - fix the root cause
- Don't "fix" by reverting unrelated changes
