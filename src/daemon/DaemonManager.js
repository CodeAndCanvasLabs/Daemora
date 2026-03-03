import { execSync, execFileSync } from "child_process";
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { config } from "../config/default.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVICE_NAME = "daemora-agent";
const SERVICE_LABEL = "com.daemora.agent";

/**
 * Daemon Manager - native OS service management.
 *
 * Like OpenClaw: uses the OS's native service system, NOT pm2.
 * - macOS: LaunchAgent (launchctl) - ~/Library/LaunchAgents/
 * - Linux: systemd user service - ~/.config/systemd/user/
 * - Windows: Scheduled Task (schtasks)
 *
 * Features:
 * - Auto-starts on machine boot/login
 * - User can stop/start/restart via CLI
 * - Graceful shutdown
 * - Crash auto-restart
 * - Logs to data/logs/
 */

export class DaemonManager {
  constructor() {
    this.platform = process.platform;
    this.entryPoint = join(config.rootDir, "src", "index.js");
    this.nodeExe = process.execPath;
    this.logsDir = join(config.dataDir, "logs");
  }

  /**
   * Install the daemon service (auto-start on boot).
   */
  install() {
    mkdirSync(this.logsDir, { recursive: true });

    if (this.platform === "darwin") {
      return this.installMacOS();
    } else if (this.platform === "linux") {
      return this.installLinux();
    } else if (this.platform === "win32") {
      return this.installWindows();
    } else {
      throw new Error(`Unsupported platform: ${this.platform}`);
    }
  }

  /**
   * Uninstall the daemon service (remove auto-start).
   */
  uninstall() {
    if (this.platform === "darwin") {
      return this.uninstallMacOS();
    } else if (this.platform === "linux") {
      return this.uninstallLinux();
    } else if (this.platform === "win32") {
      return this.uninstallWindows();
    }
  }

  /**
   * Start the daemon.
   */
  start() {
    if (this.platform === "darwin") {
      execSync(`launchctl load ~/Library/LaunchAgents/${SERVICE_LABEL}.plist 2>/dev/null; launchctl start ${SERVICE_LABEL}`);
    } else if (this.platform === "linux") {
      execSync(`systemctl --user start ${SERVICE_NAME}`);
    } else if (this.platform === "win32") {
      execSync(`schtasks /Run /TN "${SERVICE_NAME}"`);
    }
    console.log(`[Daemon] Started`);
  }

  /**
   * Stop the daemon.
   */
  stop() {
    if (this.platform === "darwin") {
      execSync(`launchctl stop ${SERVICE_LABEL} 2>/dev/null || true`);
    } else if (this.platform === "linux") {
      execSync(`systemctl --user stop ${SERVICE_NAME} 2>/dev/null || true`);
    } else if (this.platform === "win32") {
      execSync(`taskkill /IM node.exe /F 2>nul || true`);
    }
    console.log(`[Daemon] Stopped`);
  }

  /**
   * Restart the daemon.
   */
  restart() {
    this.stop();
    this.start();
    console.log(`[Daemon] Restarted`);
  }

  /**
   * Get daemon status.
   */
  status() {
    try {
      if (this.platform === "darwin") {
        const out = execSync(`launchctl list ${SERVICE_LABEL} 2>/dev/null`, { encoding: "utf-8" });
        const pidMatch = out.match(/"PID"\s*=\s*(\d+)/);
        return { running: !!pidMatch, pid: pidMatch ? parseInt(pidMatch[1]) : null, platform: "launchd" };
      } else if (this.platform === "linux") {
        const out = execSync(`systemctl --user is-active ${SERVICE_NAME} 2>/dev/null`, { encoding: "utf-8" }).trim();
        return { running: out === "active", platform: "systemd" };
      }
    } catch {
      return { running: false, platform: this.platform };
    }
    return { running: false, platform: this.platform };
  }

  // ===== macOS LaunchAgent =====

  installMacOS() {
    const plistPath = join(
      process.env.HOME,
      "Library",
      "LaunchAgents",
      `${SERVICE_LABEL}.plist`
    );

    const envPath = join(config.rootDir, ".env");

    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${this.nodeExe}</string>
    <string>${this.entryPoint}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${config.rootDir}</string>
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
  <string>${this.logsDir}/daemon-stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${this.logsDir}/daemon-stderr.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>DAEMON_MODE</key>
    <string>true</string>
  </dict>
</dict>
</plist>`;

    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, plist, "utf-8");

    // Load the service
    try {
      execSync(`launchctl unload ${plistPath} 2>/dev/null || true`);
    } catch {}
    execSync(`launchctl load ${plistPath}`);

    console.log(`[Daemon] macOS LaunchAgent installed: ${plistPath}`);
    console.log(`[Daemon] Will auto-start on login`);
    console.log(`[Daemon] Logs: ${this.logsDir}/daemon-*.log`);
    return { plistPath };
  }

  uninstallMacOS() {
    const plistPath = join(
      process.env.HOME,
      "Library",
      "LaunchAgents",
      `${SERVICE_LABEL}.plist`
    );
    try {
      execSync(`launchctl unload ${plistPath} 2>/dev/null || true`);
    } catch {}
    if (existsSync(plistPath)) {
      unlinkSync(plistPath);
    }
    console.log(`[Daemon] macOS LaunchAgent uninstalled`);
  }

  // ===== Linux systemd =====

  installLinux() {
    const unitDir = join(process.env.HOME, ".config", "systemd", "user");
    const unitPath = join(unitDir, `${SERVICE_NAME}.service`);

    const unit = `[Unit]
Description=Daemora - 24/7 AI Digital Worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${this.nodeExe} ${this.entryPoint}
WorkingDirectory=${config.rootDir}
Environment=NODE_ENV=production
Environment=DAEMON_MODE=true
Restart=always
RestartSec=5
KillMode=process
StandardOutput=append:${this.logsDir}/daemon-stdout.log
StandardError=append:${this.logsDir}/daemon-stderr.log

[Install]
WantedBy=default.target
`;

    mkdirSync(unitDir, { recursive: true });
    writeFileSync(unitPath, unit, "utf-8");

    execSync("systemctl --user daemon-reload");
    execSync(`systemctl --user enable ${SERVICE_NAME}`);
    execSync(`systemctl --user start ${SERVICE_NAME}`);

    // Enable lingering so service runs even when user is not logged in
    try {
      execSync(`loginctl enable-linger ${process.env.USER}`);
    } catch {
      console.log(`[Daemon] Warning: Could not enable linger. Service may stop on logout.`);
    }

    console.log(`[Daemon] systemd user service installed: ${unitPath}`);
    console.log(`[Daemon] Will auto-start on boot`);
    console.log(`[Daemon] Logs: ${this.logsDir}/daemon-*.log`);
    return { unitPath };
  }

  uninstallLinux() {
    try {
      execSync(`systemctl --user stop ${SERVICE_NAME} 2>/dev/null || true`);
      execSync(`systemctl --user disable ${SERVICE_NAME} 2>/dev/null || true`);
    } catch {}
    const unitPath = join(
      process.env.HOME,
      ".config",
      "systemd",
      "user",
      `${SERVICE_NAME}.service`
    );
    if (existsSync(unitPath)) {
      unlinkSync(unitPath);
    }
    try {
      execSync("systemctl --user daemon-reload");
    } catch {}
    console.log(`[Daemon] systemd user service uninstalled`);
  }

  // ===== Windows Scheduled Task =====

  installWindows() {
    const batPath = join(config.dataDir, `${SERVICE_NAME}.cmd`);
    const bat = `@echo off
set NODE_ENV=production
set DAEMON_MODE=true
cd /d "${config.rootDir}"
"${this.nodeExe}" "${this.entryPoint}" >> "${this.logsDir}\\daemon-stdout.log" 2>> "${this.logsDir}\\daemon-stderr.log"
`;
    writeFileSync(batPath, bat, "utf-8");

    try {
      execSync(`schtasks /Delete /TN "${SERVICE_NAME}" /F 2>nul`, { stdio: "ignore" });
    } catch {}
    execSync(
      `schtasks /Create /TN "${SERVICE_NAME}" /TR "${batPath}" /SC ONLOGON /RL LIMITED /F`
    );

    console.log(`[Daemon] Windows Scheduled Task installed: ${SERVICE_NAME}`);
    console.log(`[Daemon] Will auto-start on login`);
    return { batPath };
  }

  uninstallWindows() {
    try {
      execSync(`schtasks /Delete /TN "${SERVICE_NAME}" /F 2>nul`);
    } catch {}
    console.log(`[Daemon] Windows Scheduled Task uninstalled`);
  }
}

const daemonManager = new DaemonManager();
export default daemonManager;
