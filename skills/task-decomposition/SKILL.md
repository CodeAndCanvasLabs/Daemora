---
name: task-decomposition
description: Break a fuzzy goal into independently shippable phases. Make sure to use this skill whenever you (or another agent) is starting a multi-step task and need to identify the right cut-points — what can run first, what depends on what, where the natural seams are. Pairs with the planning skill.
triggers: [decompose, breakdown, "break down", phases, milestones, "step by step", roadmap, "where do I start"]
requires_tools: []
version: 1.0.0
enabled: true
---

# Task Decomposition

How to cut a big goal into pieces a single agent (or crew) can ship.

## When to apply

Whenever you're about to write a plan, build a campaign, or kick off
work that has more than one moving part. Use this BEFORE the planning
skill — decomposition gives you the phases; planning fills in the
cron, tools, and success criteria for each.

## The three cuts

### 1. Cut by outcome, not by activity

**Activity-cut (bad):**
1. Research
2. Write
3. Edit
4. Post

**Outcome-cut (good):**
1. Voice profile from existing posts → `data/voice.md`
2. First batch of 5 drafts based on voice → `data/drafts.md`
3. First post live + engagement window 24h → tweet id + counts

Each phase produces something *you can point at* when it's done.
"Research" doesn't ship. "Voice profile written to file" ships.

### 2. Cut at dependency boundaries

Start by listing what each phase needs from the previous one:

| Phase | Needs from previous | Produces |
|---|---|---|
| Voice profile | (nothing) | voice.md |
| Drafts | voice.md | drafts.md |
| Live post | drafts.md | tweet id, engagement |
| Weekly review | tweet ids ×N | recommendations.md |

If phase B needs nothing from phase A, they're independent → run in
parallel. If B needs A's output, A must finish first.

### 3. Cut for the smallest reviewable unit

Each phase should be small enough that the user can review the
output in under 5 minutes. If a phase's output is "30 days of posts,"
the user can't review that — split it so the first 3 days happen,
get reviewed, then the rest run.

## Heuristics

### Time-box every phase
- Estimate hours, days, or recurring cadence. Phases that "take as
  long as they take" rot.
- If a phase estimate is > 1 week, it's actually multiple phases.

### Mark blocking vs non-blocking
- Some phases block: "Get the user's API key" must finish before
  "make API calls."
- Some don't: "Generate avatar art" doesn't block "write voice
  profile."
- The plan should run non-blocking phases in parallel.

### Identify the riskiest phase first
- The phase most likely to fail is the phase you should ship first,
  not last. If "TikTok upload" is the part you're least sure works,
  test that on day 1 with a throwaway video — don't save it for day
  20 of a 30-day plan.

### Write the success check before the work
For each phase, write the one observable check that proves it's done:
- Phase: "Set up Twitter posting"
- Done when: "Cron job 'daily-post' has fired ≥ 1 time and the
  resulting tweet id is logged."

This pulls the phase from "I worked on it" into "it works."

## Anti-patterns

| Smell | Fix |
|---|---|
| Phases named with verbs ("Research", "Build", "Optimize") | Rename with outcomes ("Audit complete", "MVP shipped", "p95 < 200ms") |
| 12+ phases | You're elaborating, not decomposing. Merge phases that share an outcome. |
| Phase with no output artifact | Either it's not a real phase (delete) or you forgot what it produces (add). |
| All phases sequential | Look harder — most plans have 1-2 parallelizable branches. |
| "Final review" as the last phase | If the only check happens at the end, you're shipping blind. Put a checkpoint after every 2-3 phases. |

## Output

When you've decomposed a goal, hand off to the **planning** skill
with a list like:

```
Phases:
1. <outcome> — produces <artifact>; needs <prereqs>; <duration>
2. <outcome> — produces <artifact>; needs <phase 1 output>; <cadence>
3. ...
Success check per phase: <observable>
Riskiest: phase <N> — test first.
```

The planning skill turns that into a full plan with cron, crews, and
the approval gate.
