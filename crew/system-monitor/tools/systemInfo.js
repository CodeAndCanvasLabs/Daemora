import os from "node:os";
import { execSync } from "node:child_process";

/**
 * systemInfo - check system health metrics.
 *
 * Actions:
 * - overview: CPU, memory, uptime, load averages
 * - disk: disk usage per mount point
 * - processes: top processes by CPU/memory
 * - network: network interfaces and IPs
 * - all: everything combined
 */
export async function systemInfo(params) {
  const action = params?.action || "overview";

  switch (action) {
    case "overview":
      return getOverview();
    case "disk":
      return getDiskUsage();
    case "processes":
      return getProcesses(params?.sortBy || "cpu", params?.limit || 10);
    case "network":
      return getNetworkInfo();
    case "all":
      return [getOverview(), getDiskUsage(), getProcesses("cpu", 10), getNetworkInfo()].join("\n\n---\n\n");
    default:
      return `Unknown action "${action}". Use: overview, disk, processes, network, all`;
  }
}

function getOverview() {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memPercent = ((usedMem / totalMem) * 100).toFixed(1);
  const uptimeHours = (os.uptime() / 3600).toFixed(1);
  const load = os.loadavg();

  return `## System Overview

- **Hostname:** ${os.hostname()}
- **Platform:** ${os.platform()} ${os.arch()} (${os.release()})
- **CPUs:** ${cpus.length}x ${cpus[0]?.model?.trim() || "unknown"}
- **Memory:** ${formatBytes(usedMem)} / ${formatBytes(totalMem)} (${memPercent}% used)
- **Free Memory:** ${formatBytes(freeMem)}
- **Uptime:** ${uptimeHours} hours
- **Load Average:** ${load.map(l => l.toFixed(2)).join(", ")} (1m, 5m, 15m)`;
}

function getDiskUsage() {
  try {
    const cmd = process.platform === "win32"
      ? "wmic logicaldisk get size,freespace,caption"
      : "df -h 2>/dev/null | head -20";
    const output = execSync(cmd, { timeout: 5000, encoding: "utf-8" });
    return `## Disk Usage\n\n\`\`\`\n${output.trim()}\n\`\`\``;
  } catch (err) {
    return `## Disk Usage\n\nFailed to get disk info: ${err.message}`;
  }
}

function getProcesses(sortBy = "cpu", limit = 10) {
  try {
    let cmd;
    if (process.platform === "darwin") {
      // macOS: ps doesn't support --sort or -e, use -A with -r (sort by CPU desc)
      const sortFlag = sortBy === "memory" ? "-m" : "-r";
      cmd = `ps -Ao pid,%cpu,%mem,comm ${sortFlag} | head -${limit + 1}`;
    } else if (process.platform === "win32") {
      cmd = "tasklist /FO TABLE /NH";
    } else {
      // Linux: ps supports --sort
      cmd = `ps aux --sort=-%${sortBy === "memory" ? "mem" : "cpu"} | head -${limit + 1}`;
    }
    const output = execSync(cmd, { timeout: 5000, encoding: "utf-8" });
    return `## Top Processes (by ${sortBy})\n\n\`\`\`\n${output.trim()}\n\`\`\``;
  } catch (err) {
    return `## Top Processes\n\nFailed: ${err.message}`;
  }
}

function getNetworkInfo() {
  const interfaces = os.networkInterfaces();
  const lines = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.internal) continue;
      lines.push(`- **${name}:** ${addr.address} (${addr.family})`);
    }
  }
  return `## Network Interfaces\n\n${lines.length > 0 ? lines.join("\n") : "No external interfaces found"}`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}

export const systemInfoDescription = "systemInfo(action) - Check system health. action: overview | disk | processes | network | all";
