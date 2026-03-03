---
name: healthcheck
description: Monitor system health, check disk usage, CPU load, memory, running processes, network connectivity, and service status. Use when the user asks about system health, disk space, memory usage, CPU usage, running processes, server status, or whether a service is running.
triggers: health check, disk space, memory usage, CPU usage, system status, process running, server health, is running, disk full, system monitor, uptime, load average
metadata: {"daemora": {"emoji": "🩺"}}
---

## Quick checks

```bash
df -h                                                           # disk usage
vm_stat && uptime                                               # memory + CPU (macOS)
free -h && uptime                                               # memory + CPU (Linux)
ps aux | sort -k3 -rn | head -10                                # top CPU processes
ps aux | sort -k4 -rn | head -10                                # top memory processes
lsof -i :3000 | grep LISTEN                                     # check if port in use
lsof -nP -iTCP -sTCP:LISTEN | awk 'NR>1 {print $1, $9}' | sort -u  # all listening ports
pgrep -fl nginx                                                 # check if process is running
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/health  # HTTP health check
```

## Workflow

1. Run the relevant checks based on what was asked
2. Present results as a clean status dashboard
3. Flag anything wrong - high disk %, processes not running, unreachable endpoints
4. Suggest fixes for common issues

## Output format

```
🖥  System Health - [hostname]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ Uptime:   up 3 days, 4:22
✅ CPU:      load 0.8 / 1.2 / 1.5  (8 cores)
✅ Memory:   6.2GB used / 16GB total
⚠️ Disk /:   82%  (38GB free)  - getting full

Services:
✅ node       (PID 4821)
✅ postgres   (PID 1203)
❌ redis      not running
```
