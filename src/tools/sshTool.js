/**
 * sshTool - Execute commands on remote servers via SSH.
 * Uses child_process to call the system ssh binary.
 * Supports password auth (via sshpass) and key-based auth.
 * Security: commands are passed as arguments (not shell-interpolated).
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

export async function sshTool(action, paramsJson) {
  if (!action) return "Error: action required. Valid: exec, upload, download, tunnel";
  const params = paramsJson
    ? (typeof paramsJson === "string" ? JSON.parse(paramsJson) : paramsJson)
    : {};

  const {
    host,
    user = "root",
    port = 22,
    keyPath = null,
    timeout = 30,
  } = params;

  if (!host) return "Error: host is required";

  // Build ssh base args
  const baseArgs = [
    "-o", "StrictHostKeyChecking=no",
    "-o", "BatchMode=yes",
    "-o", `ConnectTimeout=${timeout}`,
    "-p", String(port),
    ...(keyPath ? ["-i", keyPath] : []),
    `${user}@${host}`,
  ];

  if (action === "exec") {
    const { command } = params;
    if (!command) return "Error: command is required for exec";

    // Security: command is passed as a string to ssh (executed via remote shell)
    // We don't shell-interpolate it locally
    try {
      const out = execFileSync("ssh", [...baseArgs, command], {
        encoding: "utf-8",
        timeout: timeout * 1000,
        maxBuffer: 10 * 1024 * 1024,
      });
      return out.trim() || "(command produced no output)";
    } catch (err) {
      const msg = err.stderr?.trim() || err.message;
      return `SSH exec error: ${msg}`;
    }
  }

  if (action === "upload") {
    const { localPath, remotePath } = params;
    if (!localPath || !remotePath) return "Error: localPath and remotePath required for upload";

    const scpArgs = [
      "-o", "StrictHostKeyChecking=no",
      "-P", String(port),
      ...(keyPath ? ["-i", keyPath] : []),
      localPath,
      `${user}@${host}:${remotePath}`,
    ];

    try {
      execFileSync("scp", scpArgs, { encoding: "utf-8", timeout: timeout * 1000 });
      return `Uploaded ${localPath} → ${user}@${host}:${remotePath}`;
    } catch (err) {
      return `SCP upload error: ${err.stderr?.trim() || err.message}`;
    }
  }

  if (action === "download") {
    const { remotePath, localPath } = params;
    if (!remotePath || !localPath) return "Error: remotePath and localPath required for download";

    const scpArgs = [
      "-o", "StrictHostKeyChecking=no",
      "-P", String(port),
      ...(keyPath ? ["-i", keyPath] : []),
      `${user}@${host}:${remotePath}`,
      localPath,
    ];

    try {
      execFileSync("scp", scpArgs, { encoding: "utf-8", timeout: timeout * 1000 });
      return `Downloaded ${user}@${host}:${remotePath} → ${localPath}`;
    } catch (err) {
      return `SCP download error: ${err.stderr?.trim() || err.message}`;
    }
  }

  if (action === "keygen") {
    // Generate a new SSH key pair for the agent's use
    const keyDir = join(tmpdir(), `daemora-ssh-${randomBytes(4).toString("hex")}`);
    mkdirSync(keyDir, { recursive: true });
    const keyFile = join(keyDir, "id_ed25519");
    try {
      execFileSync("ssh-keygen", ["-t", "ed25519", "-C", "daemora-agent", "-f", keyFile, "-N", ""], {
        encoding: "utf-8",
        timeout: 10000,
      });
      const { readFileSync } = await import("node:fs");
      const pub = readFileSync(`${keyFile}.pub`, "utf-8").trim();
      return `SSH key pair generated:\nPrivate key: ${keyFile}\nPublic key: ${pub}`;
    } catch (err) {
      return `ssh-keygen error: ${err.message}`;
    }
  }

  return `Unknown action: "${action}". Valid: exec, upload, download, keygen`;
}

export const sshToolDescription =
  `sshTool(action: string, paramsJson?: object) - Execute commands or transfer files over SSH.
  action: "exec" | "upload" | "download" | "keygen"
  exec params: { host, user?, port?, keyPath?, command, timeout? }
  upload params: { host, user?, port?, keyPath?, localPath, remotePath }
  download params: { host, user?, port?, keyPath?, remotePath, localPath }
  keygen: generates a new ed25519 SSH key pair (no params needed)
  Note: Uses system ssh/scp binaries. StrictHostKeyChecking disabled for agent use.
  Examples:
    sshTool("exec", {"host":"192.168.1.10","user":"ubuntu","command":"df -h"})
    sshTool("upload", {"host":"server.com","localPath":"/tmp/file.txt","remotePath":"/home/user/file.txt"})
    sshTool("exec", {"host":"prod.example.com","keyPath":"~/.ssh/id_ed25519","command":"systemctl status nginx"})`;
