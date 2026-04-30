/**
 * DaemonManager — native OS service supervisor.
 *
 * macOS  → ~/Library/LaunchAgents/com.daemora.agent.plist (launchctl)
 * Linux  → ~/.config/systemd/user/daemora-agent.service  (systemctl --user)
 * Windows→ Scheduled Task "daemora-agent" running a .cmd wrapper
 *
 * Responsibilities:
 * - install/uninstall the service (auto-start on login/boot)
 * - start/stop/restart/status at runtime
 * - inject VAULT_PASSPHRASE into the service environment when given one
 *
 * Entry-point resolution: prefers a compiled `dist/cli.mjs` (run via
 * `node`). Falls back to `tsx src/cli/index.ts start` in dev. Both run
 * with cwd == project root and NODE_ENV=production + DAEMON_MODE=true.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createLogger } from "../util/logger.js";

const log = createLogger("daemon");

export const SERVICE_NAME = "daemora-agent";
export const SERVICE_LABEL = "com.daemora.agent";

export type DaemonPlatform = "launchd" | "systemd" | "schtasks" | "unsupported";

export interface DaemonStatus {
  readonly running: boolean;
  readonly platform: DaemonPlatform;
  readonly pid?: number;
  readonly installed: boolean;
}

export interface InstallResult {
  readonly servicePath: string;
  readonly platform: DaemonPlatform;
}

interface EntryPoint {
  readonly exec: string;
  readonly args: readonly string[];
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export class DaemonManager {
  readonly platform: NodeJS.Platform;
  readonly rootDir: string;
  readonly logsDir: string;
  readonly dataDir: string;
  private readonly entry: EntryPoint;

  constructor(opts: { rootDir?: string; dataDir?: string } = {}) {
    this.platform = process.platform;
    this.rootDir = opts.rootDir ?? inferRootDir();
    this.dataDir = opts.dataDir ?? join(this.rootDir, "data");
    this.logsDir = join(this.dataDir, "logs");
    this.entry = resolveEntry(this.rootDir);
  }

  install(passphrase?: string): InstallResult {
    mkdirSync(this.logsDir, { recursive: true });
    if (this.platform === "darwin") return this.installMacOS(passphrase);
    if (this.platform === "linux") return this.installLinux(passphrase);
    if (this.platform === "win32") return this.installWindows(passphrase);
    throw new Error(`Unsupported platform: ${this.platform}`);
  }

  uninstall(): void {
    if (this.platform === "darwin") this.uninstallMacOS();
    else if (this.platform === "linux") this.uninstallLinux();
    else if (this.platform === "win32") this.uninstallWindows();
  }

  start(passphrase?: string): void {
    if (this.platform === "darwin") {
      if (passphrase) this.injectMacOSPassphrase(passphrase);
      const plistPath = this.plistPath();
      execSync(`launchctl load ${shellQuote(plistPath)} 2>/dev/null; launchctl start ${SERVICE_LABEL}`);
    } else if (this.platform === "linux") {
      if (passphrase) {
        execSync(`systemctl --user set-environment VAULT_PASSPHRASE=${shellQuote(passphrase)}`);
      }
      execSync(`systemctl --user start ${SERVICE_NAME}`);
    } else if (this.platform === "win32") {
      if (passphrase) this.injectWindowsPassphrase(passphrase);
      execSync(`schtasks /Run /TN "${SERVICE_NAME}"`);
    } else {
      throw new Error(`Unsupported platform: ${this.platform}`);
    }
    log.info("daemon started");
  }

  stop(): void {
    try {
      if (this.platform === "darwin") {
        execSync(`launchctl stop ${SERVICE_LABEL} 2>/dev/null || true`);
      } else if (this.platform === "linux") {
        execSync(`systemctl --user stop ${SERVICE_NAME} 2>/dev/null || true`);
      } else if (this.platform === "win32") {
        execSync(`schtasks /End /TN "${SERVICE_NAME}" 2>nul || exit 0`);
      }
    } catch {
      // swallow — "not running" is not an error worth raising
    }
    log.info("daemon stopped");
  }

  restart(passphrase?: string): void {
    this.stop();
    this.start(passphrase);
  }

  status(): DaemonStatus {
    if (this.platform === "darwin") {
      const installed = existsSync(this.plistPath());
      try {
        const out = execSync(`launchctl list ${SERVICE_LABEL}`, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
        const pidMatch = /"PID"\s*=\s*(\d+)/.exec(out);
        return {
          running: !!pidMatch,
          platform: "launchd",
          installed,
          ...(pidMatch ? { pid: Number(pidMatch[1]) } : {}),
        };
      } catch {
        return { running: false, platform: "launchd", installed };
      }
    }
    if (this.platform === "linux") {
      const installed = existsSync(this.unitPath());
      try {
        const out = execSync(`systemctl --user is-active ${SERVICE_NAME}`, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        return { running: out === "active", platform: "systemd", installed };
      } catch {
        return { running: false, platform: "systemd", installed };
      }
    }
    if (this.platform === "win32") {
      try {
        const out = execSync(`schtasks /Query /TN "${SERVICE_NAME}" /FO LIST`, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
        const running = /Status:\s*Running/i.test(out);
        return { running, platform: "schtasks", installed: true };
      } catch {
        return { running: false, platform: "schtasks", installed: false };
      }
    }
    return { running: false, platform: "unsupported", installed: false };
  }

  // ---------- macOS ----------

  private plistPath(): string {
    return join(homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
  }

  private installMacOS(passphrase: string | undefined): InstallResult {
    const plistPath = this.plistPath();
    const plist = this.renderPlist(passphrase);
    mkdirSync(dirname(plistPath), { recursive: true });
    try { execSync(`launchctl unload ${shellQuote(plistPath)} 2>/dev/null || true`); } catch { /* ignore */ }
    writeFileSync(plistPath, plist, "utf-8");
    execSync(`launchctl load ${shellQuote(plistPath)}`);
    log.info({ plistPath }, "installed LaunchAgent");
    return { servicePath: plistPath, platform: "launchd" };
  }

  private uninstallMacOS(): void {
    const plistPath = this.plistPath();
    try { execSync(`launchctl unload ${shellQuote(plistPath)} 2>/dev/null || true`); } catch { /* ignore */ }
    if (existsSync(plistPath)) unlinkSync(plistPath);
    log.info("uninstalled LaunchAgent");
  }

  private renderPlist(passphrase: string | undefined): string {
    const args = [this.entry.exec, ...this.entry.args]
      .map((a) => `    <string>${xmlEscape(a)}</string>`)
      .join("\n");
    const passphraseEntry = passphrase
      ? `    <key>VAULT_PASSPHRASE</key>\n    <string>${xmlEscape(passphrase)}</string>\n`
      : "";
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(this.rootDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(join(this.logsDir, "daemon-stdout.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(this.logsDir, "daemon-stderr.log"))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>DAEMON_MODE</key>
    <string>true</string>
${passphraseEntry}  </dict>
</dict>
</plist>`;
  }

  private injectMacOSPassphrase(passphrase: string): void {
    const plistPath = this.plistPath();
    if (!existsSync(plistPath)) return;
    let plist = readFileSync(plistPath, "utf-8");
    plist = plist.replace(/\s*<key>VAULT_PASSPHRASE<\/key>\s*<string>[^<]*<\/string>/g, "");
    const entry = `    <key>VAULT_PASSPHRASE</key>\n    <string>${xmlEscape(passphrase)}</string>\n  `;
    const lastClose = plist.lastIndexOf("</dict>");
    const envDictClose = plist.lastIndexOf("</dict>", lastClose - 1);
    if (envDictClose !== -1) {
      plist = plist.slice(0, envDictClose) + entry + plist.slice(envDictClose);
    }
    try { execSync(`launchctl unload ${shellQuote(plistPath)} 2>/dev/null || true`); } catch { /* ignore */ }
    writeFileSync(plistPath, plist, "utf-8");
  }

  // ---------- Linux ----------

  private unitPath(): string {
    return join(homedir(), ".config", "systemd", "user", `${SERVICE_NAME}.service`);
  }

  private installLinux(passphrase: string | undefined): InstallResult {
    const unitPath = this.unitPath();
    const passphraseEnv = passphrase ? `\nEnvironment=VAULT_PASSPHRASE=${passphrase}` : "";
    const execStart = [this.entry.exec, ...this.entry.args].map(shellQuote).join(" ");
    const unit = `[Unit]
Description=Daemora — self-hosted AI agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${execStart}
WorkingDirectory=${this.rootDir}
Environment=NODE_ENV=production
Environment=DAEMON_MODE=true${passphraseEnv}
Restart=always
RestartSec=5
KillMode=process
StandardOutput=append:${join(this.logsDir, "daemon-stdout.log")}
StandardError=append:${join(this.logsDir, "daemon-stderr.log")}

[Install]
WantedBy=default.target
`;
    mkdirSync(dirname(unitPath), { recursive: true });
    writeFileSync(unitPath, unit, "utf-8");
    execSync("systemctl --user daemon-reload");
    execSync(`systemctl --user enable ${SERVICE_NAME}`);
    execSync(`systemctl --user start ${SERVICE_NAME}`);
    try {
      const user = process.env["USER"] ?? process.env["LOGNAME"] ?? "";
      if (user) execSync(`loginctl enable-linger ${user}`, { stdio: "ignore" });
    } catch {
      log.warn("could not enable linger — service will stop on logout");
    }
    log.info({ unitPath }, "installed systemd user service");
    return { servicePath: unitPath, platform: "systemd" };
  }

  private uninstallLinux(): void {
    try { execSync(`systemctl --user stop ${SERVICE_NAME} 2>/dev/null || true`); } catch { /* ignore */ }
    try { execSync(`systemctl --user disable ${SERVICE_NAME} 2>/dev/null || true`); } catch { /* ignore */ }
    const unitPath = this.unitPath();
    if (existsSync(unitPath)) unlinkSync(unitPath);
    try { execSync("systemctl --user daemon-reload"); } catch { /* ignore */ }
    log.info("uninstalled systemd user service");
  }

  // ---------- Windows ----------

  private batPath(): string {
    return join(this.dataDir, `${SERVICE_NAME}.cmd`);
  }

  private installWindows(passphrase: string | undefined): InstallResult {
    const batPath = this.batPath();
    const passphraseLine = passphrase ? `set VAULT_PASSPHRASE=${passphrase}\n` : "";
    const cmdLine = [this.entry.exec, ...this.entry.args].map((a) => `"${a}"`).join(" ");
    const bat = `@echo off
set NODE_ENV=production
set DAEMON_MODE=true
${passphraseLine}cd /d "${this.rootDir}"
${cmdLine} >> "${join(this.logsDir, "daemon-stdout.log")}" 2>> "${join(this.logsDir, "daemon-stderr.log")}"
`;
    mkdirSync(dirname(batPath), { recursive: true });
    writeFileSync(batPath, bat, "utf-8");
    try { execSync(`schtasks /Delete /TN "${SERVICE_NAME}" /F 2>nul`, { stdio: "ignore" }); } catch { /* ignore */ }
    execSync(`schtasks /Create /TN "${SERVICE_NAME}" /TR "${batPath}" /SC ONLOGON /RL LIMITED /F`);
    log.info({ batPath }, "installed Scheduled Task");
    return { servicePath: batPath, platform: "schtasks" };
  }

  private uninstallWindows(): void {
    try { execSync(`schtasks /Delete /TN "${SERVICE_NAME}" /F 2>nul`); } catch { /* ignore */ }
    const batPath = this.batPath();
    if (existsSync(batPath)) unlinkSync(batPath);
    log.info("uninstalled Scheduled Task");
  }

  private injectWindowsPassphrase(passphrase: string): void {
    const batPath = this.batPath();
    if (!existsSync(batPath)) return;
    let bat = readFileSync(batPath, "utf-8");
    bat = bat.replace(/set VAULT_PASSPHRASE=[^\r\n]*\r?\n/g, "");
    bat = bat.replace(/set DAEMON_MODE=true\r?\n/, `set DAEMON_MODE=true\r\nset VAULT_PASSPHRASE=${passphrase}\r\n`);
    writeFileSync(batPath, bat, "utf-8");
  }
}

/**
 * Resolve the script to run. Priority:
 *   1. Bundled CLI at `dist/cli.mjs` → node + that
 *   2. `tsx` resolvable from project → tsx + src/cli/index.ts
 *   3. Fallback: `npx -y tsx` + src/cli/index.ts (last resort)
 */
function resolveEntry(rootDir: string): EntryPoint {
  const bundled = join(rootDir, "dist", "cli.mjs");
  if (existsSync(bundled)) {
    return { exec: process.execPath, args: [bundled, "start"] };
  }
  const tsxBin = join(rootDir, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
  const srcEntry = join(rootDir, "src", "cli", "index.ts");
  if (existsSync(tsxBin) && existsSync(srcEntry)) {
    return { exec: tsxBin, args: [srcEntry, "start"] };
  }
  // Last resort — relies on npx being on PATH when the service starts.
  return { exec: "npx", args: ["-y", "tsx", srcEntry, "start"] };
}

/**
 * Walk up from the module location to find the project root (nearest
 * package.json). Falls back to cwd if the search fails.
 */
function inferRootDir(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    let dir = here;
    for (let i = 0; i < 6; i++) {
      if (existsSync(join(dir, "package.json"))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch { /* ignore — fall through */ }
  return process.cwd();
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./-]+$/.test(s)) return s;
  return `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
}
