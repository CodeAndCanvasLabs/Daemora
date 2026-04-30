---
name: system-admin
description: Linux commands, process management, monitoring, log analysis, server administration
triggers: linux, process, service, systemctl, log, monitor, disk, memory, cpu, network, firewall, cron, ssh, permission, chmod, chown, user, group, package, apt, brew, yum
---
## Process Management
- List: `ps aux | grep name`, `pgrep -la name`
- Kill: `kill PID` (graceful), `kill -9 PID` (force)
- Top: `htop` or `top -o %CPU`
- Background: `command &`, `nohup command &`, `disown`

## Disk & Storage
- Usage: `df -h` (mounts), `du -sh /path/*` (directory sizes)
- Find large files: `find / -type f -size +100M -exec ls -lh {} \;`
- Cleanup: `apt autoremove`, clear caches, old logs

## Networking
- Ports: `ss -tlnp` (listening), `lsof -i :port`
- Connectivity: `ping`, `curl -I url`, `traceroute host`
- DNS: `dig domain`, `nslookup domain`
- Firewall: `ufw status` (Ubuntu), `iptables -L`

## Log Analysis
- Tail: `tail -f /var/log/syslog`
- Search: `grep -i error /var/log/app.log | tail -20`
- Journal: `journalctl -u service -f --since "1 hour ago"`
- Count patterns: `grep -c "ERROR" logfile`

## System Info
- OS: `uname -a`, `cat /etc/os-release`
- Memory: `free -h`
- CPU: `nproc`, `lscpu`
- Uptime: `uptime`

## Package Management
- macOS: `brew install/update/upgrade/list`
- Ubuntu/Debian: `apt update && apt install pkg`
- Node.js: `npm/pnpm install`, `nvm use version`

## Don't
- Don't run `rm -rf /` or destructive commands without confirming scope
- Don't change permissions to 777 - use minimum required
- Don't edit system config files without backup
- Don't kill processes without understanding what they do
