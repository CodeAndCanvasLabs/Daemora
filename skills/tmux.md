---
name: tmux
description: Create, manage, and control tmux sessions, windows, and panes. Send commands to running sessions, monitor output, split panes, run background processes in named sessions, and supervise long-running tasks. Use when the user asks to manage terminal sessions, run something in the background in tmux, monitor a running process, or control tmux.
triggers: tmux, terminal session, background session, tmux window, tmux pane, split terminal, persistent session, attach session, detach session, monitor process
---

## When to Use

✅ Running long background tasks in named sessions, monitoring running processes, splitting terminal workspace, sending input to interactive CLIs, managing multiple parallel jobs

❌ Simple one-off background commands → use `executeCommand` with `background:true` directly

## Check tmux is Available

```bash
which tmux && tmux -V || echo "tmux not found - install with: brew install tmux"
```

## Session Management

```bash
# List all sessions
tmux ls
# → main: 3 windows (created Mon Mar 3 09:00:00 2026) [220x50]

# Create a new named session (detached, runs in background)
tmux new-session -d -s mywork

# Create session and run a command immediately
tmux new-session -d -s server -x 220 -y 50 \; send-keys "npm run dev" Enter

# Attach to a session (interactive)
tmux attach -t mywork

# Kill a session
tmux kill-session -t mywork

# Kill all sessions
tmux kill-server
```

## Run Commands in a Session

```bash
# Send a command to an existing session
tmux send-keys -t mywork "ls -la" Enter

# Send to a specific window
tmux send-keys -t mywork:0 "npm test" Enter

# Send to a specific pane (window:pane)
tmux send-keys -t mywork:0.1 "python3 script.py" Enter

# Send without pressing Enter (useful for pre-filling input)
tmux send-keys -t mywork "git commit -m '"
```

## Read Output from a Session

```bash
# Capture what's currently visible in a pane
tmux capture-pane -t mywork -p

# Capture last 200 lines (including scrollback)
tmux capture-pane -t mywork -p -S -200

# Save pane content to file
tmux capture-pane -t mywork -p -S -500 > /tmp/session_output.txt

# Check if a process is still running in a pane
tmux capture-pane -t mywork -p | tail -5
```

## Split Panes (Parallel Work)

```bash
# Split current window vertically (left | right)
tmux split-window -h -t mywork

# Split horizontally (top / bottom)
tmux split-window -v -t mywork

# Run different commands in each pane
tmux send-keys -t mywork:0.0 "npm run dev" Enter       # left pane: dev server
tmux send-keys -t mywork:0.1 "npm run test -- --watch" Enter  # right pane: test watcher

# Create a full monitoring layout
tmux new-session -d -s monitor -x 220 -y 50
tmux send-keys -t monitor "htop" Enter
tmux split-window -h -t monitor
tmux send-keys -t monitor:0.1 "tail -f /var/log/system.log" Enter
tmux split-window -v -t monitor:0.1
tmux send-keys -t monitor:0.2 "watch -n 2 df -h" Enter
```

## Useful Shortcuts Reference

```
tmux new -s NAME        New session named NAME
tmux ls                 List sessions
tmux a -t NAME          Attach to session
tmux kill-session -t N  Kill session

Inside tmux (prefix is Ctrl+b by default):
  d         Detach from session
  c         New window
  n/p       Next/previous window
  %         Split vertically
  "         Split horizontally
  arrow     Move between panes
  z         Zoom current pane (toggle)
  q         Show pane numbers
  [         Scroll mode (q to exit)
```
