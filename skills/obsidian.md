---
name: obsidian
description: Read, create, edit, search, and manage notes in an Obsidian vault. Use when the user asks to create a note, find a note, update an Obsidian file, search the vault, or manage their knowledge base.
triggers: obsidian, note, vault, knowledge base, zettelkasten, markdown note, create note, find note, link note, obsidian search
metadata: {"daemora": {"emoji": "📓", "os": ["darwin"]}}
---

## Find vault location

```bash
python3 -c "
import json, pathlib
config = pathlib.Path.home() / 'Library/Application Support/obsidian/obsidian.json'
for v in json.loads(config.read_text()).get('vaults', {}).values():
    print(v['path'], '(open)' if v.get('open') else '')
"
# Common locations: ~/Documents/Obsidian/, ~/Notes/
```

Set `VAULT` to the path once found.

## Read notes

```bash
find $VAULT -name "*.md" | head -20                     # list all notes
grep -r "search term" $VAULT --include="*.md" -l        # search by content
grep -r "#tagname" $VAULT --include="*.md" -l           # find by tag
```

## Create a note

Use the `writeFile` tool to create `$VAULT/Folder/Note Title.md` with YAML frontmatter:

```markdown
---
title: Note Title
date: 2026-03-03
tags: [tag1, tag2]
---

# Note Title

Content here. Link to other notes with [[Other Note]].
```

## Daily note

Create `$VAULT/Daily Notes/YYYY-MM-DD.md` with today's date.

## Open in Obsidian (macOS)

```bash
open "obsidian://open?vault=VAULT_NAME&file=PATH/TO/NOTE"
open "obsidian://search?vault=VAULT_NAME&query=search+term"
```

## Errors

- **Vault not found** → read `~/Library/Application Support/obsidian/obsidian.json` for vault paths
- **File already exists** → append content or create new file with timestamp suffix
- **Encoding** → always use UTF-8 when writing `.md` files
