---
name: apple-notes
description: Create, read, search, list, and manage Apple Notes on macOS using AppleScript and the osascript command. Use when the user asks to create a note in Apple Notes, find a note, read note content, or add to an existing note. macOS only.
triggers: apple notes, notes app, create note, add note, find note, search notes, notes folder, icloud notes
---

## When to Use

✅ Create new notes, read note content, list all notes, search by title or content, append to existing notes, create notes in specific folders, move notes

❌ Notes on iOS/iPadOS (use Shortcuts app on device), bulk export of all notes (use File > Export in Notes.app)

## Requirements

- macOS (Notes.app is built-in)
- AppleScript permissions: go to System Preferences → Privacy & Security → Automation → grant permission to Terminal (or Daemora) to control Notes

## Create a New Note

```bash
osascript << 'EOF'
tell application "Notes"
    tell account "iCloud"  -- or "On My Mac" for local notes
        tell folder "Notes"  -- default folder; change to your folder name
            make new note with properties {name:"Note Title", body:"Note content here

Can include multiple lines and <b>basic HTML formatting</b>."}
        end tell
    end tell
end tell
EOF
```

## Create Note in a Specific Folder

```bash
osascript << 'EOF'
tell application "Notes"
    -- Create folder if it doesn't exist
    set targetFolder to "Work"
    tell account "iCloud"
        if not (exists folder targetFolder) then
            make new folder with properties {name:targetFolder}
        end if
        tell folder targetFolder
            set noteContent to "# Meeting Summary

Date: " & (do shell script "date '+%B %d, %Y'") & "

## Key Points
- Point 1
- Point 2

## Action Items
- [ ] Task 1
- [ ] Task 2"
            make new note with properties {name:"Meeting Summary", body:noteContent}
        end tell
    end tell
end tell
EOF
```

## List All Notes (with titles and dates)

```bash
osascript << 'EOF'
tell application "Notes"
    set output to ""
    repeat with n in notes
        set noteDate to modification date of n
        set output to output & name of n & " | " & (noteDate as string) & "\n"
    end repeat
    return output
end tell
EOF
```

## Search Notes by Title

```bash
# Search by title keyword
osascript << 'SCRIPT'
tell application "Notes"
    set searchTerm to "meeting"
    set results to ""
    repeat with n in notes
        if name of n contains searchTerm then
            set results to results & name of n & "\n"
        end if
    end repeat
    if results is "" then
        return "No notes found containing: " & searchTerm
    else
        return "Found notes:\n" & results
    end if
end tell
SCRIPT
```

## Read Note Content

```bash
osascript << 'EOF'
tell application "Notes"
    set targetNote to first note whose name is "Note Title Here"
    return body of targetNote
end tell
EOF
```

## Append to Existing Note

```bash
osascript << 'EOF'
tell application "Notes"
    set targetNote to first note whose name is "My Note"
    set currentBody to body of targetNote
    set newContent to "

--- Appended " & (do shell script "date '+%Y-%m-%d %H:%M'") & " ---
New content here."
    set body of targetNote to currentBody & newContent
end tell
EOF
```

## List All Folders

```bash
osascript -e 'tell application "Notes" to get name of folders'
```

## Error Handling

| Error | Fix |
|-------|-----|
| Permission denied | System Settings → Privacy & Security → Automation → enable Notes for Terminal |
| Folder not found | List folders first with `osascript -e 'tell application "Notes" to get name of folders'`; create folder first |
| Note not found | Use `whose name contains "..."` instead of exact match |
| iCloud sync issues | Wait for sync or use `account "On My Mac"` for local notes |
