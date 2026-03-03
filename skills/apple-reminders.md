---
name: apple-reminders
description: Create, read, complete, and manage Apple Reminders on macOS using AppleScript. Use when the user asks to add a reminder, set a due date, list reminders, mark as done, or manage reminder lists. macOS only. Syncs with iPhone via iCloud.
triggers: reminder, reminders, add reminder, set reminder, due date, alert, remind me, reminder list, todo reminder, apple reminders
---

## When to Use

✅ Create reminders with due dates/times, list pending reminders, mark complete, create reminder lists, set location-based reminders

❌ Complex task management (use Things or Trello skill) - use Reminders for simple "remind me at X time" tasks

## Create a Reminder

```bash
# Simple reminder (no due date)
osascript << 'EOF'
tell application "Reminders"
    tell list "Reminders"
        make new reminder with properties {name:"Buy groceries"}
    end tell
end tell
EOF

# Reminder with due date and time
osascript << 'EOF'
tell application "Reminders"
    tell list "Reminders"
        set dueDate to current date
        set day of dueDate to 15
        set month of dueDate to 3
        set year of dueDate to 2026
        set hours of dueDate to 9
        set minutes of dueDate to 0
        set seconds of dueDate to 0
        make new reminder with properties {
            name:"Call the dentist",
            due date:dueDate,
            remind me date:dueDate
        }
    end tell
end tell
EOF
```

## List Pending Reminders

```bash
osascript << 'EOF'
tell application "Reminders"
    set output to ""
    set pending to (reminders whose completed is false)
    repeat with r in pending
        set dueInfo to ""
        if due date of r is not missing value then
            set dueInfo to " [due: " & (due date of r as string) & "]"
        end if
        set output to output & name of r & dueInfo & "\n"
    end repeat
    if output is "" then return "No pending reminders"
    return output
end tell
EOF
```

## Mark Reminder Complete

```bash
osascript << 'EOF'
tell application "Reminders"
    set targetReminder to first reminder whose name is "Buy groceries"
    set completed of targetReminder to true
end tell
EOF
```

## List All Reminder Lists

```bash
osascript -e 'tell application "Reminders" to get name of lists'
```

## Create a New Reminder List

```bash
osascript << 'EOF'
tell application "Reminders"
    make new list with properties {name:"Shopping", color:green}
end tell
EOF
```

## Response Format for Users

When confirming reminders created, format clearly:

```
✅ Reminder set:
  📌 Call the dentist
  📅 Monday, March 16 at 9:00 AM
  📋 List: Reminders
  🔔 Alert: At time of reminder
```
