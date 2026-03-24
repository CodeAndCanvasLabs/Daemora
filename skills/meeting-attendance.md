---
name: meeting-attendance
description: Join video meetings (Zoom/Meet/Teams) via a dedicated sub-agent that handles live conversation and returns a full summary
triggers: join meeting, attend meeting, meeting, zoom, google meet, teams meeting, join call, join this call, attend this
---

## How to Join a Meeting

Spawn a `meeting-attendant` sub-agent with the meeting URL. It handles everything:
- Joins the meeting (Docker container starts with STT→LLM→TTS pipeline)
- Actively listens, speaks, takes notes
- Detects when the meeting ends (auto-kills container)
- Returns a full transcript + summary

### Call pattern

```
spawnAgent({
  profile: "meeting-attendant",
  task: "Join this meeting and participate actively, take notes, and return a full summary when done. Meeting URL: <url>"
})
```

### What happens inside the sub-agent
1. Joins via browser (Playwright in Docker)
2. Docker container runs the voice loop autonomously: STT → LLM → TTS
3. Sub-agent polls every 2s via `meetingAction("poll")` to monitor
4. When meeting ends or bot is removed → container auto-killed → sub-agent gets full transcript → writes summary → returns to you

### You receive back
- Full meeting summary (participants, decisions, action items, key quotes)
- Saved to `data/meetings/YYYY-MM-DD-<platform>.md`

### Notes
- You do NOT need to manage the meeting yourself - the sub-agent handles everything
- Supported platforms: Google Meet, Zoom, Teams (auto-detected from URL)
- Container auto-kills on meeting end, kick, or leave
