---
name: planning
description: Produce structured executable plans from a user goal — any domain. Make sure to use this skill whenever the user (or another agent) needs a plan, strategy, roadmap, or breakdown of how a multi-step task will be done — even if the word "plan" isn't used. Pairs with the task-decomposition skill.
triggers: [plan, strategy, roadmap, breakdown, "step by step", phases, "how would you", "what's the approach"]
requires_tools: []
version: 1.0.0
enabled: true
---

# Planning

Turn a goal into an executable plan. Never execute from this skill —
hand the plan back for the caller to run.

## When to apply

Whenever the work is multi-step, multi-day, or coordinated across
multiple owners (crews, sub-agents, MCP servers, the main agent
itself). Skip planning for a single-action task.

## What every plan contains

```
# Plan: <one-line goal>

## Goal & success criteria
- Observable definition of done
- 2–3 falsifiable checks

## Assumptions & prerequisites
- Crews / skills / MCP servers / integrations / API keys needed
- Open questions for the user

## Phases
1. <Phase name — 1-line outcome>
   - Owner: <crew | sub-agent | MCP server | main agent>
   - Tool(s) / skill(s): <names from the live inventory>
   - Steps: <numbered, concrete>
   - Output: <artifact / record / message>
   - Cadence: <one-shot | recurring with cron expression>

## Schedule (cron, if any)
| name | cron | runs |
|---|---|---|

## Risks & mitigations
- Likely failure modes + how the plan reacts

## Approval gate
Reply 'go' to start. Reply 'tweak <part>' to revise.
```

Skip sections that don't apply. Don't pad.

## How to think

### Map to real names
Every owner / tool / skill / server you reference must already exist
in the running daemora install. Look them up first. If something
isn't there, list it as a prerequisite the user must add.

### Outcome cuts, not activity cuts
A phase = a thing you can point at when done. Phase names with
verbs ("research", "build", "optimize") rarely produce evidence;
phase names with outcomes do.

### Schedule with commitment
If the work is recurring, write the cron expression. "Daily" alone
is not a schedule.

### Surface unknowns honestly
If the goal as stated doesn't give you enough to commit, list the
gaps in **Open questions** rather than guessing.

### Right-size
A small plan that ships beats a long plan that doesn't. Cut every
line that doesn't change a decision.

### Stay generic
Plans should work for any domain — code, content, research, ops,
monitoring, comms, infrastructure, anything. Don't infer a domain
from a few keywords; mirror the user's vocabulary.

## When a plan already exists

If the caller hands you a structured plan, **validate, don't
regenerate**. Confirm every owner/tool/skill/server is real,
prerequisites are met, cron expressions parse, success checks are
observable. Return one of:

- "Executable as-written. Confirm prerequisites:" + checklist
- "Gaps:" + specific items + a fix per gap

## Guardrails

- Reference secrets by vault key name only; never paste values.
- Stay inside the user's stated scope.
- Refuse illegal / deceptive / mass-spam asks in one sentence.
