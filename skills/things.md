---
name: things
description: Manage Things 3 tasks, projects, and areas on macOS. Create todos with due dates, deadlines, checklists, tags, and notes. List inbox, today, and upcoming tasks. Use when the user asks to add a task to Things, check their to-do list, create a project, or manage Things 3.
triggers: things, things 3, add task, todo, to-do, create task, things inbox, things today, upcoming tasks, things project, things area, things tag
metadata: {"daemora": {"emoji": "✅", "install": ["brew install --cask things"], "os": ["darwin"]}}
---

## Add task (URL scheme - no permissions needed)

```bash
open "things:///add?title=Buy+groceries&when=today&tags=personal"
open "things:///add?title=Deploy+v2&when=2026-03-15&deadline=2026-03-20&list=Engineering"
open "things:///add-project?title=Q1+Planning&notes=..."
# Checklist items: &checklist-items=Step+1%0AStep+2%0AStep+3 (newline-separated, URL-encoded)
```

## `when` values

| Value | Meaning |
|-------|---------|
| `today` | Scheduled for today |
| `tomorrow` | Tomorrow |
| `evening` | This evening |
| `anytime` | Anytime (no date) |
| `someday` | Someday |
| `YYYY-MM-DD` | Specific date |

## Read tasks (SQLite - requires Full Disk Access)

```bash
THINGS_DB=$(find ~/Library/Group\ Containers -name "main.sqlite" -path "*Things*" 2>/dev/null | head -1)
sqlite3 "$THINGS_DB" "SELECT title, dueDate FROM TMTask WHERE status=0 AND trashed=0 AND type=0 ORDER BY dueDate ASC LIMIT 20;"
```

## Workflow

1. **Adding tasks** → use the `things:///add` URL scheme (no permissions needed)
2. **Reading tasks** → query the SQLite database with `executeCommand`
3. **With checklists** → pass `checklist-items` URL param, newline-separated, URL-encoded

## Errors

| Error | Fix |
|-------|-----|
| DB not found | Open Things 3 first; try `find ~/Library -name "*.sqlite3" 2>/dev/null \| grep -i things` |
| Permission denied on DB | System Settings → Privacy → Full Disk Access → add Terminal |
| URL scheme not working | Ensure Things 3 is installed (`ls /Applications/Things3.app`) |
