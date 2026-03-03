---
name: skill-creator
description: Create new Daemora skills. Use when the user asks to create a new skill, package a capability, teach the agent a new behavior, or add a new skill file.
triggers: create skill, new skill, add skill, make skill, package skill, teach agent, skill creator, write skill
metadata: {"daemora": {"emoji": "🛠️"}}
---

## What is a skill

A `.md` file in `skills/`. When a task matches the skill's `triggers`, the skill's content is injected into the system prompt for that task.

## Skill format

```markdown
---
name: skill-name
description: What this skill does and WHEN to use it. Include trigger phrases - this is how the agent decides to load it.
triggers: keyword1, keyword2, phrase, another phrase
metadata: {"daemora": {"emoji": "🔧", "requires": {"bins": ["tool-name"]}, "install": ["brew install tool-name"], "os": ["darwin"]}}
---

## When to use

✅ Cases where this skill applies
❌ Cases where it does NOT apply

## Core behavior

[What to do, what commands to run, how to respond]

## Common commands

[Brief command examples - 2-5 lines, not full scripts]

## Errors

| Error | Fix |
|-------|-----|
| ... | ... |
```

## Creation process

1. **Understand the domain** - what tools/commands/APIs does it use? Platform requirements?
2. **Choose good triggers** - every way a user might ask: colloquial + technical + action verbs
3. **Write behavioral instructions** - what to DO, not code templates to copy-paste
4. **Include brief command examples** - 2-5 lines max per example
5. **Save as** `skills/skill-name.md`

## After creating

```bash
curl -s -X POST http://localhost:8081/skills/reload
# → {"loaded": 22, "skills": [..., "new-skill"]}
```

Or restart: `daemora start`

## Checklist before saving

- [ ] `description` includes the key trigger phrases
- [ ] `triggers` covers all reasonable ways a user would ask
- [ ] Body is behavioral instructions, not code templates to copy-paste
- [ ] Commands are real - no invented flags or fictional APIs
- [ ] Platform requirements noted (macOS-only, requires X, etc.)
- [ ] Not a duplicate of an existing skill (`ls skills/`)
