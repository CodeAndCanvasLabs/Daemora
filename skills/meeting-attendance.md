---
name: meeting-attendance
description: Join video meetings (Zoom/Meet/Teams), participate in live voice conversation, and return full transcript for summarization
triggers: join meeting, attend meeting, meeting, zoom, google meet, teams meeting, join call, join this call, attend this
---

## Meeting Attendance — How to Join and Run a Meeting

You handle meetings end-to-end: join → run conversation loop → return transcript.

Docker handles the voice conversation autonomously (STT→LLM→TTS pipeline inside container). Your job: join, monitor via poll, detect end, get transcript, summarize.

---

### STEP 1 — Join

```
meetingAction("join", { url: "<meeting-url>", displayName: "Daemora" })
```

Returns `{ sessionId, platform, state }`. Save `sessionId`.

**Immediately after join** — speak a greeting:
```
meetingAction("speak", { sessionId, text: "Hi everyone, I'm Daemora. I'll be listening and participating." })
```

---

### STEP 2 — Poll Loop (run until meeting ends)

Docker handles voice conversation autonomously. You monitor via polling.

```
meetingAction("poll", { sessionId, since: 0 })   // first call
```

Returns `{ entries, total, nextSince, status }`.

- Always set `since = nextSince` on the next call
- `status: "new_speech"` → read entries, decide if you need to interject
- `status: "no_new_speech"` → poll again (don't stop)
- **NEVER stop polling** until meeting explicitly ends

**When to interject via speak:**
- Someone addresses you by name → respond
- Direct question you can answer → answer in 1-2 sentences
- Decision needs confirmation → "Got it, going with X."
- Meeting wrapping up → "Want me to summarize?"

**When to speak:**
```
meetingAction("speak", { sessionId, text: "your response" })
```

---

### STEP 3 — Detect Meeting End

Meeting is over when:
- Someone says "thanks bye", "meeting over", "you can leave", "goodbye everyone"
- Host ends the meeting (poll returns `status: "ended"` or similar)
- User explicitly tells you to stop

**Do NOT leave for:**
- Silence (people step away, come back)
- Only 1-2 entries (meeting just started)
- No one speaking (wait — they'll return)

---

### STEP 4 — Leave and Summarize

```
meetingAction("leave", { sessionId })
meetingAction("transcript", { sessionId, last: 1000 })
```

Then write a summary using `createDocument` with this format:

```markdown
# Meeting Summary

**Date:** YYYY-MM-DD
**Duration:** Xm Ys
**Platform:** Google Meet / Teams / Zoom
**Participants:** Name1, Name2, Name3

## Overview
2-3 sentence executive summary.

## Discussion Points
### Topic 1: [Title]
- Key points, attributed to speakers

## Decisions Made
- Decision — who decided, context

## Action Items
| # | Action | Owner | Deadline |
|---|--------|-------|----------|
| 1 | Description | Person | Date/TBD |

## Key Quotes
- "Exact quote" — Speaker

## Next Steps
- What happens next

## Raw Transcript
[Full transcript]
```

Save to `data/meetings/YYYY-MM-DD-<platform>.md`.

---

### Rules
- Short responses — 1-2 sentences max when speaking
- Natural tone — "Yeah, that makes sense." not "The discussion revealed that..."
- Never produce placeholder summaries — use actual content from transcript
- Always read full transcript before writing summary
- Keep polling. The loop is your job until someone ends the meeting.
