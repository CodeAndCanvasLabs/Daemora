#!/usr/bin/env node

/**
 * Daemora CLI
 *
 * Usage:
 *   daemora start              Start the agent (foreground)
 *   daemora setup              Interactive setup wizard
 *   daemora daemon <action>    Manage OS daemon service
 *   daemora vault <action>     Manage encrypted secret vault
 *   daemora help               Show help
 */

import chalk from "chalk";
import { config } from "./config/default.js";
import daemonManager from "./daemon/DaemonManager.js";
import secretVault from "./safety/SecretVault.js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const P = {
  brand: "#7C6AFF",
  accent: "#4ECDC4",
  success: "#2ECC71",
  error: "#E74C3C",
  muted: "#7F8C8D",
  dim: "#555E68",
};

const t = {
  brand: (s) => chalk.hex(P.brand)(s),
  accent: (s) => chalk.hex(P.accent)(s),
  success: (s) => chalk.hex(P.success)(s),
  error: (s) => chalk.hex(P.error)(s),
  muted: (s) => chalk.hex(P.muted)(s),
  bold: (s) => chalk.bold(s),
  h: (s) => chalk.bold.hex(P.brand)(s),
  cmd: (s) => chalk.hex(P.accent)(s),
  dim: (s) => chalk.hex(P.dim)(s),
};

const S = {
  check: chalk.hex(P.success)("\u2714"),
  cross: chalk.hex(P.error)("\u2718"),
  arrow: chalk.hex(P.brand)("\u25B8"),
  dot: chalk.hex(P.muted)("\u00B7"),
  bar: chalk.hex(P.dim)("\u2502"),
  info: chalk.hex(P.accent)("\u25C6"),
  lock: chalk.hex("#F1C40F")("\u25A3"),
};

const [,, command, subcommand, ...rest] = process.argv;

async function main() {
  switch (command) {
    case "start":
      // If vault exists, prompt for passphrase and inject secrets before server boot
      if (secretVault.exists()) {
        const { password } = await import("@clack/prompts");
        console.log("");
        const passphrase = await password({
          message: "Vault detected. Enter passphrase to unlock",
        });
        if (passphrase && typeof passphrase === "string") {
          try {
            secretVault.unlock(passphrase);
            const secrets = secretVault.getAsEnv();
            for (const [key, value] of Object.entries(secrets)) {
              process.env[key] = value;
            }
            console.log(`\n  ${S.check}  Vault unlocked \u2014 ${Object.keys(secrets).length} secret(s) loaded\n`);
          } catch {
            console.log(`\n  ${S.cross}  Wrong passphrase. Starting without vault secrets.\n`);
          }
        } else {
          console.log(`\n  ${S.arrow}  Skipped vault. Starting without secrets.\n`);
        }
      }
      await import("./index.js");
      break;

    case "daemon":
      handleDaemon(subcommand);
      break;

    case "vault":
      handleVault(subcommand, rest);
      break;

    case "mcp":
      await handleMCP(subcommand, rest);
      break;

    case "sandbox":
      handleSandbox(subcommand, rest);
      break;

    case "tenant":
      await handleTenant(subcommand, rest);
      break;

    case "doctor":
      await handleDoctor();
      break;

    case "setup":
      const { runSetupWizard } = await import("./setup/wizard.js");
      await runSetupWizard();
      break;

    case "help":
    case "--help":
    case "-h":
    case undefined:
      printHelp();
      break;

    default:
      console.error(`\n  ${S.cross}  Unknown command: ${chalk.bold(command)}`);
      printHelp();
      process.exit(1);
  }
}

function handleDaemon(action) {
  const header = `\n  ${t.h("Daemora Daemon")}\n`;

  switch (action) {
    case "install":
      console.log(header);
      console.log(`  ${S.arrow}  Installing daemon service...`);
      daemonManager.install();
      console.log(`\n  ${S.check}  Daemon installed. Will auto-start on boot.`);
      console.log(`  ${S.arrow}  Run ${t.cmd("daemora daemon start")} to start now.\n`);
      break;

    case "uninstall":
      console.log(header);
      console.log(`  ${S.arrow}  Uninstalling daemon service...`);
      daemonManager.uninstall();
      console.log(`\n  ${S.check}  Daemon uninstalled.\n`);
      break;

    case "start":
      console.log(header);
      daemonManager.start();
      console.log(`  ${S.check}  Daemon started.\n`);
      break;

    case "stop":
      console.log(header);
      daemonManager.stop();
      console.log(`  ${S.check}  Daemon stopped.\n`);
      break;

    case "restart":
      console.log(header);
      daemonManager.restart();
      console.log(`  ${S.check}  Daemon restarted.\n`);
      break;

    case "status": {
      console.log(header);
      const st = daemonManager.status();
      const status = st.running
        ? t.success("\u25CF Running")
        : t.muted("\u25CB Stopped");
      console.log(`  ${S.bar}  Status      ${status}`);
      console.log(`  ${S.bar}  Platform    ${t.bold(st.platform)}`);
      if (st.pid) console.log(`  ${S.bar}  PID         ${t.bold(st.pid)}`);
      console.log(`  ${S.bar}  Logs        ${t.muted(daemonManager.logsDir)}`);
      console.log("");
      break;
    }

    case "logs": {
      const stdoutLog = join(daemonManager.logsDir, "daemon-stdout.log");
      const stderrLog = join(daemonManager.logsDir, "daemon-stderr.log");
      const lines = process.argv[4] || "50";
      console.log(header);
      console.log(`  ${S.bar}  ${t.muted(stdoutLog)}\n`);
      try {
        const out = execSync(`tail -n ${lines} "${stdoutLog}" 2>/dev/null || echo "(no output log yet)"`).toString();
        console.log(out);
      } catch { console.log("  (no output log yet)\n"); }
      const errExists = existsSync(stderrLog);
      if (errExists) {
        const err = execSync(`tail -n 20 "${stderrLog}" 2>/dev/null`).toString().trim();
        if (err) {
          console.log(`  ${S.bar}  ${t.muted("stderr:")}\n`);
          console.log(err);
        }
      }
      break;
    }

    default:
      console.error(`\n  ${S.cross}  Unknown daemon command: ${action || "(none)"}`);
      console.log(`  ${t.muted("Usage:")} daemora daemon ${t.dim("[install|uninstall|start|stop|restart|status|logs]")}\n`);
      process.exit(1);
  }
}

function handleVault(action, args) {
  const header = `\n  ${t.h("Daemora Vault")}\n`;

  switch (action) {
    case "set": {
      const [passphrase, key, value] = args;
      if (!passphrase || !key || !value) {
        console.error(`\n  ${S.cross}  Usage: daemora vault set ${t.dim("<passphrase> <key> <value>")}\n`);
        process.exit(1);
      }
      secretVault.unlock(passphrase);
      secretVault.set(key, value);
      console.log(`${header}  ${S.check}  Secret ${t.bold(key)} stored.\n`);
      secretVault.lock();
      break;
    }

    case "get": {
      const [p2, k2] = args;
      if (!p2 || !k2) {
        console.error(`\n  ${S.cross}  Usage: daemora vault get ${t.dim("<passphrase> <key>")}\n`);
        process.exit(1);
      }
      secretVault.unlock(p2);
      const val = secretVault.get(k2);
      if (val) {
        console.log(val);
      } else {
        console.log(`${header}  ${S.cross}  Secret ${t.bold(k2)} not found.\n`);
      }
      secretVault.lock();
      break;
    }

    case "list": {
      const p3 = args[0];
      if (!p3) {
        console.error(`\n  ${S.cross}  Usage: daemora vault list ${t.dim("<passphrase>")}\n`);
        process.exit(1);
      }
      console.log(header);
      secretVault.unlock(p3);
      const secrets = secretVault.list();
      if (secrets.length === 0) {
        console.log(`  ${t.muted("No secrets stored.")}\n`);
      } else {
        const maxLen = Math.max(...secrets.map((s) => s.key.length));
        for (const s of secrets) {
          const k = t.bold(s.key.padEnd(maxLen));
          const v = t.dim(`${s.length} chars`);
          const preview = t.muted(s.preview);
          console.log(`  ${S.bar}  ${k}  ${v}  ${preview}`);
        }
        console.log(`\n  ${t.muted(`${secrets.length} secret(s) stored.`)}\n`);
      }
      secretVault.lock();
      break;
    }

    case "import": {
      const p4 = args[0];
      const envPath = args[1] || join(config.rootDir, ".env");
      if (!p4) {
        console.error(`\n  ${S.cross}  Usage: daemora vault import ${t.dim("<passphrase> [path-to-.env]")}\n`);
        process.exit(1);
      }
      secretVault.unlock(p4);
      const count = secretVault.importFromEnv(envPath);
      console.log(`${header}  ${S.check}  Imported ${t.bold(count)} secrets from ${t.dim(envPath)}\n`);
      secretVault.lock();
      break;
    }

    case "status": {
      console.log(header);
      const exists = secretVault.exists();
      const unlocked = secretVault.isUnlocked();
      console.log(`  ${S.bar}  Vault exists    ${exists ? t.success("Yes") : t.muted("No")}`);
      console.log(`  ${S.bar}  Unlocked        ${unlocked ? t.success("Yes") : t.muted("No")}`);
      console.log("");
      break;
    }

    default:
      console.error(`\n  ${S.cross}  Unknown vault command: ${action || "(none)"}`);
      console.log(`  ${t.muted("Usage:")} daemora vault ${t.dim("[set|get|list|import|status]")}\n`);
      process.exit(1);
  }
}

// ── MCP config helpers ────────────────────────────────────────────────────────

const MCP_CONFIG_PATH = join(config.rootDir, "config", "mcp.json");

function readMCPConfig() {
  if (!existsSync(MCP_CONFIG_PATH)) return { mcpServers: {} };
  try { return JSON.parse(readFileSync(MCP_CONFIG_PATH, "utf-8")); } catch { return { mcpServers: {} }; }
}

function writeMCPConfig(cfg) {
  writeFileSync(MCP_CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

async function handleMCP(action, args) {
  const header = `\n  ${t.h("Daemora MCP Servers")}\n`;

  switch (action) {

    case "list":
    case undefined: {
      console.log(header);
      const cfg = readMCPConfig();
      const servers = Object.entries(cfg.mcpServers || {}).filter(([k]) => !k.startsWith("_comment"));
      if (servers.length === 0) {
        console.log(`  ${t.muted("No MCP servers configured.")}`);
        console.log(`  ${S.arrow}  Run ${t.cmd("daemora mcp add <name> <command-or-url> [args...]")} to add one.\n`);
        return;
      }
      for (const [name, srv] of servers) {
        const enabled = srv.enabled !== false;
        const icon = enabled ? S.check : t.muted("○");
        const type = srv.command ? t.accent("stdio") : srv.transport === "sse" ? t.accent("sse") : t.accent("http");
        const target = srv.command
          ? `${t.dim(srv.command)} ${t.dim((srv.args || []).join(" "))}`
          : t.dim(srv.url);
        const envKeys = Object.keys(srv.env || {});
        const envStr = envKeys.length > 0 ? t.muted(` [env: ${envKeys.join(", ")}]`) : "";
        const disabledStr = !enabled ? t.muted(" (disabled)") : "";
        console.log(`  ${icon}  ${t.bold(name)}  ${type}  ${target}${envStr}${disabledStr}`);
      }
      console.log(`\n  ${t.muted(`${servers.length} server(s) configured.`)}\n`);
      break;
    }

    case "add": {
      const [name, commandOrUrl, ...restArgs] = args;

      // ── Interactive mode (no args or name-only) ────────────────────────────
      if (!name || !commandOrUrl) {
        const { default: pi } = await import("@clack/prompts");

        const pGuard = (val) => { if (pi.isCancel(val)) { pi.cancel("Cancelled."); process.exit(0); } return val; };

        const cfg = readMCPConfig();
        cfg.mcpServers = cfg.mcpServers || {};

        pi.intro(t.h("Add MCP Server"));

        const serverName = name || pGuard(await pi.text({
          message: "Server name (no spaces)",
          validate: (v) => {
            if (!v) return "Required";
            if (/\s/.test(v)) return "No spaces allowed";
            if (cfg.mcpServers[v] && !String(v).startsWith("_comment")) return `"${v}" already exists`;
          },
        }));

        const description = pGuard(await pi.text({
          message: "Description (what does this server do? helps the agent know when to use it)",
          placeholder: "e.g. Manage GitHub repos, PRs, and issues",
          initialValue: "",
        }));

        const transport = pGuard(await pi.select({
          message: "Transport type",
          options: [
            { value: "stdio", label: "stdio",  hint: "Local subprocess - npx, node, python, binary" },
            { value: "http",  label: "http",   hint: "Remote HTTP (streamable MCP)" },
            { value: "sse",   label: "sse",    hint: "Remote SSE (Server-Sent Events)" },
          ],
        }));

        let serverConfig = { enabled: true };

        if (transport === "stdio") {
          const cmd = pGuard(await pi.text({
            message: "Command (e.g. npx, node, python3)",
            validate: (v) => !v ? "Required" : undefined,
          }));
          const argsRaw = pGuard(await pi.text({
            message: "Arguments (space-separated, or leave blank)",
            initialValue: "",
          }));
          serverConfig.command = cmd;
          serverConfig.args = argsRaw.trim() ? argsRaw.trim().split(/\s+/) : [];

          // stdio: credentials go as env vars passed to the subprocess
          const needsEnv = pGuard(await pi.confirm({
            message: "Does this server need environment variables (API keys, tokens)?",
            initialValue: false,
          }));
          if (needsEnv) {
            serverConfig.env = {};
            p.log.info(`  Tip: use \${MY_VAR} to reference existing env vars instead of pasting secrets`);
            let more = true;
            while (more) {
              const key = pGuard(await pi.text({
                message: "Env var name (e.g. GITHUB_TOKEN)",
                validate: (v) => !v ? "Required" : undefined,
              }));
              const val = pGuard(await pi.password({
                message: `Value for ${key}  (or type \${VAR_NAME} to reference an existing env var)`,
                validate: (v) => !v ? "Required" : undefined,
              }));
              serverConfig.env[key] = val;
              more = pGuard(await pi.confirm({ message: "Add another env var?", initialValue: false }));
            }
          }

        } else {
          // http / sse
          const url = pGuard(await pi.text({
            message: transport === "sse"
              ? "SSE endpoint URL (e.g. https://api.example.com/sse)"
              : "HTTP endpoint URL (e.g. https://api.example.com/mcp)",
            validate: (v) => {
              if (!v) return "Required";
              if (!v.startsWith("http://") && !v.startsWith("https://")) return "Must start with http(s)://";
            },
          }));
          serverConfig.url = url;
          if (transport === "sse") serverConfig.transport = "sse";

          // http/sse: credentials go as HTTP request headers (Authorization, X-API-Key, etc.)
          const authType = pGuard(await pi.select({
            message: "Authentication / headers",
            options: [
              { value: "none",    label: "None",              hint: "No auth needed" },
              { value: "bearer",  label: "Bearer token",      hint: "Authorization: Bearer <token>" },
              { value: "apikey",  label: "API key header",    hint: "X-API-Key: <key>  or custom header name" },
              { value: "custom",  label: "Custom headers",    hint: "Any headers - you name them" },
            ],
          }));

          if (authType !== "none") {
            serverConfig.headers = {};
            pi.log.info(`  Tip: use \${MY_SECRET} to reference env vars instead of pasting values`);

            if (authType === "bearer") {
              const token = pGuard(await pi.password({
                message: "Bearer token  (or \${MY_ENV_VAR} to reference an env var)",
                validate: (v) => !v ? "Required" : undefined,
              }));
              serverConfig.headers["Authorization"] = `Bearer ${token}`;

            } else if (authType === "apikey") {
              const headerName = pGuard(await pi.text({
                message: "Header name",
                initialValue: "X-API-Key",
                validate: (v) => !v ? "Required" : undefined,
              }));
              const apiKey = pGuard(await pi.password({
                message: `Value for ${headerName}  (or \${MY_ENV_VAR})`,
                validate: (v) => !v ? "Required" : undefined,
              }));
              serverConfig.headers[headerName] = apiKey;

            } else {
              // custom - loop
              let more = true;
              while (more) {
                const headerName = pGuard(await pi.text({
                  message: "Header name (e.g. Authorization, X-Tenant-ID)",
                  validate: (v) => !v ? "Required" : undefined,
                }));
                const headerVal = pGuard(await pi.password({
                  message: `Value for ${headerName}  (or \${MY_ENV_VAR})`,
                  validate: (v) => !v ? "Required" : undefined,
                }));
                serverConfig.headers[headerName] = headerVal;
                more = pGuard(await pi.confirm({ message: "Add another header?", initialValue: false }));
              }
            }
          }
        }

        if (description?.trim()) serverConfig.description = description.trim();
        cfg.mcpServers[serverName] = serverConfig;
        writeMCPConfig(cfg);

        const typeLabel = transport === "stdio"
          ? `${serverConfig.command} ${(serverConfig.args || []).join(" ")}`.trim()
          : serverConfig.url;
        const credCount = Object.keys(serverConfig.env || serverConfig.headers || {}).length;
        const credLabel = transport === "stdio" ? "env var(s)" : "header(s)";

        pi.outro(
          `${S.check}  Server ${t.bold(serverName)} saved.` +
          (credCount ? `  ${credCount} ${credLabel}.` : "") +
          `\n  ${S.arrow}  Restart the agent or run: daemora mcp reload ${serverName}`
        );
        break;
      }

      // ── Non-interactive (args provided) ────────────────────────────────────
      const cfg = readMCPConfig();
      cfg.mcpServers = cfg.mcpServers || {};

      let serverConfig;
      if (commandOrUrl.startsWith("http://") || commandOrUrl.startsWith("https://")) {
        const isSSE = restArgs.includes("--sse");
        serverConfig = { url: commandOrUrl, enabled: true };
        if (isSSE) serverConfig.transport = "sse";
      } else {
        const filteredArgs = restArgs.filter(a => !a.startsWith("--"));
        serverConfig = { command: commandOrUrl, args: filteredArgs, enabled: true };
      }

      cfg.mcpServers[name] = serverConfig;
      writeMCPConfig(cfg);

      const typeLabel = serverConfig.command ? "stdio" : (serverConfig.transport || "http");
      console.log(`\n  ${S.check}  Server ${t.bold(name)} added (${typeLabel}).`);
      console.log(`  ${S.arrow}  Run ${t.cmd(`daemora mcp env ${name} KEY value`)} to add environment variables.`);
      console.log(`  ${S.arrow}  Restart the agent or run: ${t.cmd(`daemora mcp reload ${name}`)}\n`);
      break;
    }

    case "remove": {
      const [name] = args;
      if (!name) {
        console.error(`\n  ${S.cross}  Usage: daemora mcp remove ${t.dim("<name>")}\n`);
        process.exit(1);
      }
      const cfg = readMCPConfig();
      if (!cfg.mcpServers?.[name]) {
        console.error(`\n  ${S.cross}  Server "${name}" not found in config.\n`);
        process.exit(1);
      }
      delete cfg.mcpServers[name];
      writeMCPConfig(cfg);
      console.log(`\n  ${S.check}  Server ${t.bold(name)} removed from config.\n`);
      break;
    }

    case "enable":
    case "disable": {
      const enabled = action === "enable";
      const [name] = args;
      if (!name) {
        console.error(`\n  ${S.cross}  Usage: daemora mcp ${action} ${t.dim("<name>")}\n`);
        process.exit(1);
      }
      const cfg = readMCPConfig();
      if (!cfg.mcpServers?.[name]) {
        console.error(`\n  ${S.cross}  Server "${name}" not found in config.\n`);
        process.exit(1);
      }
      cfg.mcpServers[name].enabled = enabled;
      writeMCPConfig(cfg);
      const icon = enabled ? S.check : t.muted("○");
      console.log(`\n  ${icon}  Server ${t.bold(name)} ${enabled ? "enabled" : "disabled"}.\n`);
      break;
    }

    case "env": {
      // daemora mcp env <name> <KEY> <value>
      const [name, key, value] = args;
      if (!name || !key || !value) {
        console.error(`\n  ${S.cross}  Usage: daemora mcp env ${t.dim("<name> <KEY> <value>")}\n`);
        process.exit(1);
      }
      const cfg = readMCPConfig();
      if (!cfg.mcpServers?.[name]) {
        console.error(`\n  ${S.cross}  Server "${name}" not found. Use ${t.cmd("daemora mcp add")} first.\n`);
        process.exit(1);
      }
      cfg.mcpServers[name].env = cfg.mcpServers[name].env || {};
      cfg.mcpServers[name].env[key] = value;
      writeMCPConfig(cfg);
      console.log(`\n  ${S.check}  Env var ${t.bold(key)} set for server ${t.bold(name)}.\n`);
      break;
    }

    case "reload": {
      // daemora mcp reload <name>  - tells the live agent to reconnect, or just validates config
      const [name] = args;
      if (!name) {
        console.error(`\n  ${S.cross}  Usage: daemora mcp reload ${t.dim("<name>")}\n`);
        process.exit(1);
      }
      const cfg2 = readMCPConfig();
      if (!cfg2.mcpServers?.[name]) {
        console.error(`\n  ${S.cross}  Server "${name}" not found in config.\n`);
        process.exit(1);
      }
      // Try to hit the live API (best-effort, non-fatal)
      try {
        const port = process.env.PORT || "8081";
        const { default: https } = await import("https");
        const { default: http } = await import("http");
        const url = `http://localhost:${port}/mcp/${name}/reload`;
        const mod = url.startsWith("https") ? https : http;
        await new Promise((resolve) => {
          const req = mod.request(url, { method: "POST" }, (res) => {
            console.log(`\n  ${S.check}  Agent reloaded server "${t.bold(name)}" (HTTP ${res.statusCode}).\n`);
            resolve();
          });
          req.on("error", () => {
            console.log(`\n  ${S.arrow}  Agent not running. Server "${t.bold(name)}" will connect on next start.\n`);
            resolve();
          });
          req.end();
        });
      } catch {
        console.log(`\n  ${S.arrow}  Config saved. Restart the agent for changes to take effect.\n`);
      }
      break;
    }

    default:
      console.error(`\n  ${S.cross}  Unknown mcp command: ${action || "(none)"}`);
      console.log(`  ${t.muted("Usage:")} daemora mcp ${t.dim("[list|add|remove|enable|disable|reload|env]")}\n`);
      process.exit(1);
  }
}

// ── Sandbox (filesystem scoping) helpers ──────────────────────────────────────

function readEnvFile() {
  const envPath = join(config.rootDir, ".env");
  if (!existsSync(envPath)) return {};
  const lines = readFileSync(envPath, "utf-8").split("\n");
  const result = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    result[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
  }
  return result;
}

function writeEnvKey(key, value) {
  const envPath = join(config.rootDir, ".env");
  let content = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";

  // Replace existing key or append
  const regex = new RegExp(`^${key}=.*$`, "m");
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    content = content.trimEnd() + `\n${key}=${value}\n`;
  }
  writeFileSync(envPath, content, "utf-8");
}

function deleteEnvKey(key) {
  const envPath = join(config.rootDir, ".env");
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, "utf-8");
  const updated = content.replace(new RegExp(`^${key}=.*\n?`, "m"), "");
  writeFileSync(envPath, updated, "utf-8");
}

function handleSandbox(action, args) {
  const header = `\n  ${t.h("Daemora Sandbox")}  ${t.muted("Filesystem scoping")}\n`;
  const env = readEnvFile();
  const allowedPaths = env.ALLOWED_PATHS ? env.ALLOWED_PATHS.split(",").map(s => s.trim()).filter(Boolean) : [];
  const blockedPaths = env.BLOCKED_PATHS ? env.BLOCKED_PATHS.split(",").map(s => s.trim()).filter(Boolean) : [];
  const restrictCmds = env.RESTRICT_COMMANDS === "true";

  switch (action) {
    case "show":
    case undefined: {
      console.log(header);
      if (allowedPaths.length === 0) {
        console.log(`  ${S.info}  Mode        ${t.success("Global")}  ${t.muted("(no directory restrictions)")}`);
      } else {
        console.log(`  ${S.info}  Mode        ${t.accent("Scoped")}`);
        console.log(`  ${S.bar}  Allowed:`);
        for (const p of allowedPaths) console.log(`  ${S.bar}    ${t.bold(S.check)}  ${p}`);
      }
      if (blockedPaths.length > 0) {
        console.log(`  ${S.bar}  Blocked:`);
        for (const p of blockedPaths) console.log(`  ${S.bar}    ${t.error(S.cross)}  ${p}`);
      }
      console.log(`  ${S.bar}  Restrict commands  ${restrictCmds ? t.accent("true") : t.muted("false")}`);
      console.log(`\n  ${t.muted("Manage:")} daemora sandbox ${t.dim("[add|block|remove|unblock|restrict|unrestrict|clear]")}\n`);
      break;
    }

    case "add": {
      const [newPath] = args;
      if (!newPath) {
        console.error(`\n  ${S.cross}  Usage: daemora sandbox add ${t.dim("<absolute-path>")}\n`);
        process.exit(1);
      }
      if (!newPath.startsWith("/") && !newPath.match(/^[A-Za-z]:\\/)) {
        console.error(`\n  ${S.cross}  Path must be absolute (start with / or C:\\)\n`);
        process.exit(1);
      }
      const updated = [...new Set([...allowedPaths, newPath])];
      writeEnvKey("ALLOWED_PATHS", updated.join(","));
      console.log(`\n${header}  ${S.check}  ${t.bold(newPath)} added to allowed paths.`);
      console.log(`  ${S.arrow}  Scoped mode active - agent can only access: ${t.bold(updated.join(", "))}\n`);
      break;
    }

    case "remove": {
      const [rmPath] = args;
      if (!rmPath) {
        console.error(`\n  ${S.cross}  Usage: daemora sandbox remove ${t.dim("<path>")}\n`);
        process.exit(1);
      }
      const updated = allowedPaths.filter(p => p !== rmPath);
      if (updated.length === allowedPaths.length) {
        console.log(`\n  ${S.cross}  "${rmPath}" not found in allowed paths.\n`);
        process.exit(1);
      }
      if (updated.length === 0) {
        deleteEnvKey("ALLOWED_PATHS");
        console.log(`\n${header}  ${S.check}  ${t.bold(rmPath)} removed. No allowed paths left - switching to global mode.\n`);
      } else {
        writeEnvKey("ALLOWED_PATHS", updated.join(","));
        console.log(`\n${header}  ${S.check}  ${t.bold(rmPath)} removed. Remaining: ${t.bold(updated.join(", "))}\n`);
      }
      break;
    }

    case "block": {
      const [blockPath] = args;
      if (!blockPath) {
        console.error(`\n  ${S.cross}  Usage: daemora sandbox block ${t.dim("<absolute-path>")}\n`);
        process.exit(1);
      }
      const updated = [...new Set([...blockedPaths, blockPath])];
      writeEnvKey("BLOCKED_PATHS", updated.join(","));
      console.log(`\n${header}  ${S.check}  ${t.bold(blockPath)} added to blocked paths.\n`);
      break;
    }

    case "unblock": {
      const [unblockPath] = args;
      if (!unblockPath) {
        console.error(`\n  ${S.cross}  Usage: daemora sandbox unblock ${t.dim("<path>")}\n`);
        process.exit(1);
      }
      const updated = blockedPaths.filter(p => p !== unblockPath);
      if (updated.length === blockedPaths.length) {
        console.log(`\n  ${S.cross}  "${unblockPath}" not found in blocked paths.\n`);
        process.exit(1);
      }
      if (updated.length === 0) {
        deleteEnvKey("BLOCKED_PATHS");
      } else {
        writeEnvKey("BLOCKED_PATHS", updated.join(","));
      }
      console.log(`\n${header}  ${S.check}  ${t.bold(unblockPath)} unblocked.\n`);
      break;
    }

    case "restrict": {
      writeEnvKey("RESTRICT_COMMANDS", "true");
      console.log(`\n${header}  ${S.check}  RESTRICT_COMMANDS=true`);
      console.log(`  ${t.muted("Shell commands will now enforce ALLOWED_PATHS (cwd + path scanning).")}\n`);
      break;
    }

    case "unrestrict": {
      writeEnvKey("RESTRICT_COMMANDS", "false");
      console.log(`\n${header}  ${S.check}  RESTRICT_COMMANDS=false`);
      console.log(`  ${t.muted("Shell commands are no longer path-restricted (file tools still are).")}\n`);
      break;
    }

    case "clear": {
      deleteEnvKey("ALLOWED_PATHS");
      deleteEnvKey("BLOCKED_PATHS");
      deleteEnvKey("RESTRICT_COMMANDS");
      console.log(`\n${header}  ${S.check}  Filesystem scoping cleared - global mode restored.`);
      console.log(`  ${t.muted("Agent can now access any file the OS allows (hardcoded security patterns still active).")}\n`);
      break;
    }

    default:
      console.error(`\n  ${S.cross}  Unknown sandbox command: ${action}`);
      console.log(`  ${t.muted("Usage:")} daemora sandbox ${t.dim("[show|add|remove|block|unblock|restrict|unrestrict|clear]")}\n`);
      process.exit(1);
  }
}

// ── Tenant management helpers ─────────────────────────────────────────────────

async function handleTenant(action, args) {
  const header = `\n  ${t.h("Daemora Tenants")}  ${t.muted("Per-user configuration & isolation")}\n`;
  const port = process.env.PORT || "8081";
  const base = `http://localhost:${port}`;

  async function apiCall(method, path, body) {
    const { default: http } = await import("http");
    return new Promise((resolve, reject) => {
      const opts = {
        hostname: "localhost",
        port: parseInt(port),
        path,
        method,
        headers: { "Content-Type": "application/json" },
      };
      const req = http.request(opts, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      });
      req.on("error", reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  switch (action) {
    case "list":
    case undefined: {
      console.log(header);
      try {
        const res = await apiCall("GET", "/tenants");
        const { tenants, stats } = res.body;
        if (!tenants || tenants.length === 0) {
          console.log(`  ${t.muted("No tenants registered yet.")}`);
          console.log(`  ${S.arrow}  Enable ${t.cmd("MULTI_TENANT_ENABLED=true")} and start the agent to auto-register users.\n`);
          return;
        }
        const planColor = { free: t.muted, pro: t.accent, admin: t.brand };
        for (const tenant of tenants) {
          const statusIcon = tenant.suspended ? t.error(S.cross) : t.success(S.check);
          const plan = (planColor[tenant.plan] || t.muted)(tenant.plan || "free");
          const cost = `$${(tenant.totalCost || 0).toFixed(4)}`;
          const tasks = tenant.taskCount || 0;
          const model = tenant.model ? t.dim(tenant.model) : t.muted("default");
          console.log(`  ${statusIcon}  ${t.bold(tenant.id)}  ${plan}  ${t.muted(cost)}  ${t.muted(`${tasks} tasks`)}  ${model}`);
        }
        console.log(`\n  ${t.muted(`${stats.total} tenant(s)  |  ${stats.suspended} suspended  |  total spend: $${stats.totalCost}  |  total tasks: ${stats.totalTasks}`)}\n`);
      } catch {
        console.error(`\n  ${S.cross}  Agent not running. Start it with ${t.cmd("daemora start")} first.\n`);
      }
      break;
    }

    case "show": {
      const [id] = args;
      if (!id) {
        console.error(`\n  ${S.cross}  Usage: daemora tenant show ${t.dim("<tenantId>")}\n`);
        process.exit(1);
      }
      try {
        const res = await apiCall("GET", `/tenants/${encodeURIComponent(id)}`);
        if (res.status === 404) {
          console.error(`\n  ${S.cross}  Tenant "${id}" not found.\n`);
          process.exit(1);
        }
        const t2 = res.body;
        console.log(header);
        console.log(`  ${S.bar}  ID             ${t.bold(t2.id)}`);
        console.log(`  ${S.bar}  Plan           ${t.accent(t2.plan || "free")}`);
        console.log(`  ${S.bar}  Suspended      ${t2.suspended ? t.error("Yes") + (t2.suspendReason ? `  (${t2.suspendReason})` : "") : t.success("No")}`);
        console.log(`  ${S.bar}  Model          ${t2.model ? t.accent(t2.model) : t.muted("(default)")}`);
        console.log(`  ${S.bar}  Total cost     ${t.bold("$" + (t2.totalCost || 0).toFixed(4))}`);
        console.log(`  ${S.bar}  Task count     ${t.bold(t2.taskCount || 0)}`);
        console.log(`  ${S.bar}  Max cost/task  ${t2.maxCostPerTask != null ? t.bold("$" + t2.maxCostPerTask) : t.muted("(global default)")}`);
        console.log(`  ${S.bar}  Max daily cost ${t2.maxDailyCost != null ? t.bold("$" + t2.maxDailyCost) : t.muted("(global default)")}`);
        if (t2.allowedPaths?.length) console.log(`  ${S.bar}  Allowed paths  ${t.dim(t2.allowedPaths.join(", "))}`);
        if (t2.blockedPaths?.length) console.log(`  ${S.bar}  Blocked paths  ${t.dim(t2.blockedPaths.join(", "))}`);
        if (t2.tools?.length) console.log(`  ${S.bar}  Tools          ${t.dim(t2.tools.join(", "))}`);
        if (t2.notes) console.log(`  ${S.bar}  Notes          ${t.muted(t2.notes)}`);
        console.log(`  ${S.bar}  Created        ${t.dim(t2.createdAt)}`);
        console.log(`  ${S.bar}  Last seen      ${t.dim(t2.lastSeenAt)}`);
        console.log("");
      } catch {
        console.error(`\n  ${S.cross}  Agent not running.\n`);
      }
      break;
    }

    case "set": {
      // daemora tenant set <tenantId> <key> <value>
      const [id, key, ...valueParts] = args;
      const value = valueParts.join(" ");
      if (!id || !key || !value) {
        console.error(`\n  ${S.cross}  Usage: daemora tenant set ${t.dim("<tenantId> <key> <value>")}`);
        console.error(`  ${t.muted("Keys: model, plan, maxCostPerTask, maxDailyCost, notes")}\n`);
        process.exit(1);
      }
      const body = {};
      if (key === "maxCostPerTask" || key === "maxDailyCost") {
        body[key] = parseFloat(value);
      } else {
        body[key] = value;
      }
      try {
        const res = await apiCall("PATCH", `/tenants/${encodeURIComponent(id)}`, body);
        if (res.status === 404) { console.error(`\n  ${S.cross}  Tenant "${id}" not found.\n`); process.exit(1); }
        console.log(`\n${header}  ${S.check}  Tenant ${t.bold(id)}: ${t.accent(key)} = ${t.bold(value)}\n`);
      } catch { console.error(`\n  ${S.cross}  Agent not running.\n`); }
      break;
    }

    case "plan": {
      // daemora tenant plan <tenantId> <free|pro|admin>
      const [id, plan] = args;
      if (!id || !plan) {
        console.error(`\n  ${S.cross}  Usage: daemora tenant plan ${t.dim("<tenantId> <free|pro|admin>")}\n`);
        process.exit(1);
      }
      try {
        const res = await apiCall("PATCH", `/tenants/${encodeURIComponent(id)}`, { plan });
        if (res.status === 404) { console.error(`\n  ${S.cross}  Tenant "${id}" not found.\n`); process.exit(1); }
        console.log(`\n${header}  ${S.check}  Tenant ${t.bold(id)} plan set to ${t.accent(plan)}\n`);
      } catch { console.error(`\n  ${S.cross}  Agent not running.\n`); }
      break;
    }

    case "suspend": {
      const [id, ...reasonParts] = args;
      if (!id) {
        console.error(`\n  ${S.cross}  Usage: daemora tenant suspend ${t.dim("<tenantId> [reason]")}\n`);
        process.exit(1);
      }
      const reason = reasonParts.join(" ");
      try {
        const res = await apiCall("POST", `/tenants/${encodeURIComponent(id)}/suspend`, { reason });
        if (res.status === 404) { console.error(`\n  ${S.cross}  Tenant "${id}" not found.\n`); process.exit(1); }
        console.log(`\n${header}  ${S.check}  Tenant ${t.bold(id)} suspended.${reason ? `  Reason: ${t.muted(reason)}` : ""}\n`);
      } catch { console.error(`\n  ${S.cross}  Agent not running.\n`); }
      break;
    }

    case "unsuspend": {
      const [id] = args;
      if (!id) {
        console.error(`\n  ${S.cross}  Usage: daemora tenant unsuspend ${t.dim("<tenantId>")}\n`);
        process.exit(1);
      }
      try {
        const res = await apiCall("POST", `/tenants/${encodeURIComponent(id)}/unsuspend`);
        if (res.status === 404) { console.error(`\n  ${S.cross}  Tenant "${id}" not found.\n`); process.exit(1); }
        console.log(`\n${header}  ${S.check}  Tenant ${t.bold(id)} unsuspended.\n`);
      } catch { console.error(`\n  ${S.cross}  Agent not running.\n`); }
      break;
    }

    case "reset": {
      const [id] = args;
      if (!id) {
        console.error(`\n  ${S.cross}  Usage: daemora tenant reset ${t.dim("<tenantId>")}\n`);
        process.exit(1);
      }
      try {
        const res = await apiCall("POST", `/tenants/${encodeURIComponent(id)}/reset`);
        if (res.status === 404) { console.error(`\n  ${S.cross}  Tenant "${id}" not found.\n`); process.exit(1); }
        console.log(`\n${header}  ${S.check}  Tenant ${t.bold(id)} config reset (cost history preserved).\n`);
      } catch { console.error(`\n  ${S.cross}  Agent not running.\n`); }
      break;
    }

    case "delete": {
      const [id] = args;
      if (!id) {
        console.error(`\n  ${S.cross}  Usage: daemora tenant delete ${t.dim("<tenantId>")}\n`);
        process.exit(1);
      }
      try {
        const res = await apiCall("DELETE", `/tenants/${encodeURIComponent(id)}`);
        if (res.status === 404) { console.error(`\n  ${S.cross}  Tenant "${id}" not found.\n`); process.exit(1); }
        console.log(`\n${header}  ${S.check}  Tenant ${t.bold(id)} deleted.\n`);
      } catch { console.error(`\n  ${S.cross}  Agent not running.\n`); }
      break;
    }

    case "apikey": {
      // daemora tenant apikey set <tenantId> <KEY_NAME> <value>
      // daemora tenant apikey delete <tenantId> <KEY_NAME>
      // daemora tenant apikey list <tenantId>
      const [apikeyAction, ...apikeyArgs] = args;
      if (!apikeyAction) {
        console.error(`\n  ${S.cross}  Usage: daemora tenant apikey ${t.dim("[set|delete|list]")} ${t.dim("<tenantId> ...")}\n`);
        process.exit(1);
      }
      const { default: tm } = await import("./tenants/TenantManager.js");

      switch (apikeyAction) {
        case "set": {
          const [tenantId, keyName, keyValue] = apikeyArgs;
          if (!tenantId || !keyName || !keyValue) {
            console.error(`\n  ${S.cross}  Usage: daemora tenant apikey set ${t.dim("<tenantId> <KEY_NAME> <value>")}\n`);
            process.exit(1);
          }
          tm.setApiKey(tenantId, keyName, keyValue);
          console.log(`\n${header}  ${S.check}  API key ${t.bold(keyName)} stored (encrypted) for tenant ${t.bold(tenantId)}.\n`);
          break;
        }
        case "delete": {
          const [tenantId, keyName] = apikeyArgs;
          if (!tenantId || !keyName) {
            console.error(`\n  ${S.cross}  Usage: daemora tenant apikey delete ${t.dim("<tenantId> <KEY_NAME>")}\n`);
            process.exit(1);
          }
          const deleted = tm.deleteApiKey(tenantId, keyName);
          if (deleted) {
            console.log(`\n${header}  ${S.check}  API key ${t.bold(keyName)} deleted for tenant ${t.bold(tenantId)}.\n`);
          } else {
            console.log(`\n  ${S.cross}  API key ${t.bold(keyName)} not found for tenant ${t.bold(tenantId)}.\n`);
          }
          break;
        }
        case "list": {
          const [tenantId] = apikeyArgs;
          if (!tenantId) {
            console.error(`\n  ${S.cross}  Usage: daemora tenant apikey list ${t.dim("<tenantId>")}\n`);
            process.exit(1);
          }
          const keys = tm.listApiKeyNames(tenantId);
          console.log(header);
          if (keys.length === 0) {
            console.log(`  ${t.muted("No API keys stored for this tenant.")}\n`);
          } else {
            for (const k of keys) {
              console.log(`  ${S.lock}  ${t.bold(k)}  ${t.dim("(encrypted)")}`);
            }
            console.log(`\n  ${t.muted(`${keys.length} key(s) stored.`)}\n`);
          }
          break;
        }
        default:
          console.error(`\n  ${S.cross}  Unknown apikey command: ${apikeyAction}`);
          console.log(`  ${t.muted("Usage:")} daemora tenant apikey ${t.dim("[set|delete|list]")}\n`);
          process.exit(1);
      }
      break;
    }

    case "channel": {
      // daemora tenant channel set <tenantId> <key> <value>
      // daemora tenant channel unset <tenantId> <key>
      // daemora tenant channel list <tenantId>
      const VALID_KEYS = ["email", "email_password", "resend_api_key", "resend_from", "twilio_account_sid", "twilio_auth_token", "twilio_phone_from"];
      const [channelAction, ...channelArgs] = args;
      if (!channelAction) {
        console.error(`\n  ${S.cross}  Usage: daemora tenant channel ${t.dim("[set|unset|list]")} ${t.dim("<tenantId> ...")}\n`);
        process.exit(1);
      }
      const { default: tm } = await import("./tenants/TenantManager.js");
      switch (channelAction) {
        case "set": {
          const [tenantId, key, value] = channelArgs;
          if (!tenantId || !key || !value) {
            console.error(`\n  ${S.cross}  Usage: daemora tenant channel set ${t.dim("<tenantId> <key> <value>")}\n`);
            console.log(`  ${t.muted("Valid keys:")} ${VALID_KEYS.join(", ")}\n`);
            process.exit(1);
          }
          if (!VALID_KEYS.includes(key)) {
            console.error(`\n  ${S.cross}  Invalid key: "${key}"`);
            console.log(`  ${t.muted("Valid keys:")} ${VALID_KEYS.join(", ")}\n`);
            process.exit(1);
          }
          tm.setChannelConfig(tenantId, key, value);
          console.log(`\n  ${S.check}  ${t.success("Channel config set")}  ${t.muted(`${tenantId} → ${key} = [encrypted]`)}\n`);
          break;
        }
        case "unset": {
          const [tenantId, key] = channelArgs;
          if (!tenantId || !key) {
            console.error(`\n  ${S.cross}  Usage: daemora tenant channel unset ${t.dim("<tenantId> <key>")}\n`);
            process.exit(1);
          }
          const deleted = tm.deleteChannelConfig(tenantId, key);
          if (deleted) {
            console.log(`\n  ${S.check}  ${t.success("Channel config removed")}  ${t.muted(`${tenantId} → ${key}`)}\n`);
          } else {
            console.log(`\n  ${S.cross}  Key "${key}" not found for ${tenantId}\n`);
          }
          break;
        }
        case "list": {
          const [tenantId] = channelArgs;
          if (!tenantId) {
            console.error(`\n  ${S.cross}  Usage: daemora tenant channel list ${t.dim("<tenantId>")}\n`);
            process.exit(1);
          }
          const keys = tm.listChannelConfigKeys(tenantId);
          console.log(`\n  ${t.h("Channel config")}  ${t.muted(tenantId)}\n`);
          if (keys.length === 0) {
            console.log(`  ${t.muted("No channel credentials stored.")}`);
            console.log(`  ${t.dim("Use: daemora tenant channel set <id> <key> <value>")}\n`);
          } else {
            for (const k of keys) {
              console.log(`  ${S.check}  ${t.accent(k)}  ${t.muted("[encrypted]")}`);
            }
            console.log();
          }
          break;
        }
        default:
          console.error(`\n  ${S.cross}  Unknown channel command: ${channelAction}`);
          console.log(`  ${t.muted("Usage:")} daemora tenant channel ${t.dim("[set|unset|list]")}\n`);
          process.exit(1);
      }
      break;
    }

    default:
      console.error(`\n  ${S.cross}  Unknown tenant command: ${action || "(none)"}`);
      console.log(`  ${t.muted("Usage:")} daemora tenant ${t.dim("[list|show|set|plan|suspend|unsuspend|reset|delete|apikey|channel]")}\n`);
      process.exit(1);
  }
}

// ── Security Doctor ────────────────────────────────────────────────────────────

async function handleDoctor() {
  const header = `\n  ${t.h("Daemora Doctor")}  ${t.muted("Security audit")}\n`;
  console.log(header);

  const checks = [];
  const warn = (label, msg) => checks.push({ icon: chalk.hex("#F1C40F")("⚠"), label, msg, score: 0 });
  const fail = (label, msg) => checks.push({ icon: t.error("✘"), label, msg, score: 0 });
  const pass = (label) => checks.push({ icon: t.success("✔"), label, msg: null, score: 1 });

  // Read .env for checks (non-secret values only)
  const env = {};
  try {
    const { readFileSync: rfs, existsSync: exs } = await import("fs");
    const { join: pjoin } = await import("path");
    const envPath = pjoin(config.rootDir, ".env");
    if (exs(envPath)) {
      for (const line of rfs(envPath, "utf-8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx === -1) continue;
        env[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
      }
    }
  } catch {}

  // Merge process.env for checks (already loaded at startup)
  const cfg = { ...env, ...process.env };

  // 1. Secret vault configured
  if (secretVault.exists()) {
    pass("Secret vault configured");
  } else {
    warn("Secret vault not configured", "API keys are stored in plaintext .env. Run: daemora vault import <passphrase>");
  }

  // 2. DAEMORA_TENANT_KEY set (for per-tenant API key encryption)
  if (cfg.DAEMORA_TENANT_KEY && cfg.DAEMORA_TENANT_KEY.length >= 16) {
    pass("DAEMORA_TENANT_KEY set");
  } else {
    warn("DAEMORA_TENANT_KEY not set", "Per-tenant API keys encrypted with insecure dev fallback. Set DAEMORA_TENANT_KEY=<32-hex-chars>");
  }

  // 3. HTTP channel disabled (no unauthenticated /chat endpoint)
  // The HTTP chat endpoint is permanently disabled in Daemora - always passes
  pass("HTTP /chat endpoint disabled");

  // 4. All enabled channels have allowlists
  const channelAllowlistKeys = {
    TELEGRAM_BOT_TOKEN:    "TELEGRAM_ALLOWLIST",
    DISCORD_BOT_TOKEN:     "DISCORD_ALLOWLIST",
    SLACK_BOT_TOKEN:       "SLACK_ALLOWLIST",
    LINE_CHANNEL_ACCESS_TOKEN: "LINE_ALLOWLIST",
    SIGNAL_PHONE_NUMBER:   "SIGNAL_ALLOWLIST",
    TEAMS_APP_ID:          "TEAMS_ALLOWLIST",
    GOOGLE_CHAT_PROJECT_NUMBER: "GOOGLE_CHAT_ALLOWLIST",
    EMAIL_USER:            "EMAIL_ALLOWLIST",
    TWILIO_ACCOUNT_SID:    "WHATSAPP_ALLOWLIST",
  };
  const openChannels = [];
  for (const [tokenKey, allowlistKey] of Object.entries(channelAllowlistKeys)) {
    if (cfg[tokenKey] && !cfg[allowlistKey]) {
      openChannels.push(tokenKey.replace(/_BOT_TOKEN|_ACCOUNT_SID|_APP_ID|_ACCESS_TOKEN|_PHONE_NUMBER|_PROJECT_NUMBER|_USER/, "").toLowerCase());
    }
  }
  if (openChannels.length === 0) {
    pass("All enabled channels have allowlists");
  } else {
    warn(`Open channels (no allowlist): ${openChannels.join(", ")}`, "Set CHANNEL_ALLOWLIST=id1,id2 to restrict access");
  }

  // 5. Filesystem sandbox active (ALLOWED_PATHS or SANDBOX_MODE=docker)
  const hasAllowedPaths = cfg.ALLOWED_PATHS && cfg.ALLOWED_PATHS.trim().length > 0;
  const hasDockerSandbox = cfg.SANDBOX_MODE === "docker";
  const hasTenantIsolation = cfg.TENANT_ISOLATE_FILESYSTEM === "true";
  if (hasAllowedPaths || hasDockerSandbox || hasTenantIsolation) {
    pass("Filesystem sandbox active");
  } else {
    warn("Filesystem sandbox not active", "Agent can access any file. Set ALLOWED_PATHS or TENANT_ISOLATE_FILESYSTEM=true");
  }

  // 6. Multi-tenant + filesystem isolation
  const multiTenantEnabled = cfg.MULTI_TENANT_ENABLED === "true";
  if (multiTenantEnabled && hasTenantIsolation) {
    pass("Multi-tenant filesystem isolation enabled");
  } else if (multiTenantEnabled && !hasTenantIsolation) {
    warn("Multi-tenant enabled but filesystem not isolated", "Set TENANT_ISOLATE_FILESYSTEM=true to isolate tenants");
  } else {
    pass("Single-user mode (no tenant isolation needed)");
  }

  // 7. Daily cost limit set
  const hasDailyCost = cfg.MAX_DAILY_COST && parseFloat(cfg.MAX_DAILY_COST) > 0;
  if (hasDailyCost) {
    pass(`Daily cost limit set ($${cfg.MAX_DAILY_COST})`);
  } else {
    warn("No daily cost limit set", "Set MAX_DAILY_COST=10.00 to prevent runaway spend");
  }

  // 8. A2A secured (if enabled)
  const a2aEnabled = cfg.A2A_ENABLED === "true";
  if (!a2aEnabled) {
    pass("A2A disabled (secure)");
  } else if (cfg.A2A_AUTH_TOKEN && cfg.A2A_ALLOWED_AGENTS) {
    pass("A2A enabled with auth token + agent allowlist");
  } else if (cfg.A2A_AUTH_TOKEN) {
    warn("A2A enabled with auth token but no agent allowlist", "Set A2A_ALLOWED_AGENTS=https://trusted-agent.com");
  } else {
    fail("A2A enabled without auth token", "Any agent can submit tasks! Set A2A_AUTH_TOKEN=<secret>");
  }

  // Print results
  const score = checks.reduce((s, c) => s + c.score, 0);
  const total = checks.length;

  for (const check of checks) {
    console.log(`  ${check.icon}  ${check.label}`);
    if (check.msg) console.log(`     ${t.dim(check.msg)}`);
  }

  console.log("");

  const scoreColor = score === total ? t.success : score >= total * 0.75 ? chalk.hex("#F1C40F") : t.error;
  console.log(`  ${t.bold("Security score:")}  ${scoreColor(`${score}/${total}`)}`);

  if (score === total) {
    console.log(`  ${t.success("All checks passed. Daemora is production-ready.")}\n`);
  } else {
    const issues = checks.filter(c => c.score === 0);
    const critical = issues.filter(c => c.icon === t.error("✘")).length;
    if (critical > 0) {
      console.log(`  ${t.error(`${critical} critical issue(s) - fix immediately.`)}`);
    }
    const warnings = issues.filter(c => c.icon !== t.error("✘")).length;
    if (warnings > 0) {
      console.log(`  ${chalk.hex("#F1C40F")(`${warnings} warning(s) - recommended fixes.`)}`);
    }
    console.log("");
  }
}

function printHelp() {
  const w = 56;
  const line = chalk.hex(P.brand)("\u2501".repeat(w));
  const dimLine = chalk.hex(P.dim)("\u2500".repeat(w));

  console.log(`
${line}
  ${t.h("Daemora")}  ${t.muted("Your 24/7 AI Digital Worker")}
${line}

  ${t.bold("USAGE")}
  ${dimLine}
  ${t.cmd("daemora")} ${t.dim("<command>")} ${t.dim("[options]")}

  ${t.bold("COMMANDS")}
  ${dimLine}
  ${t.cmd("start")}                            Start the agent server
  ${t.cmd("setup")}                            Interactive setup wizard

  ${t.cmd("daemon install")}                   Install as OS service (auto-start)
  ${t.cmd("daemon uninstall")}                 Remove OS service
  ${t.cmd("daemon start")}                     Start the background daemon
  ${t.cmd("daemon stop")}                      Stop the daemon
  ${t.cmd("daemon restart")}                   Restart the daemon
  ${t.cmd("daemon status")}                    Check daemon status

  ${t.cmd("vault set")}  ${t.dim("<pass> <key> <val>")}   Store an encrypted secret
  ${t.cmd("vault get")}  ${t.dim("<pass> <key>")}         Retrieve a secret
  ${t.cmd("vault list")} ${t.dim("<pass>")}               List secret keys
  ${t.cmd("vault import")} ${t.dim("<pass> [.env]")}      Import from .env file
  ${t.cmd("vault status")}                    Check vault status

  ${t.cmd("mcp list")}                         List configured MCP servers
  ${t.cmd("mcp add")} ${t.dim("<name> <cmd-or-url> [args]")}   Add stdio/HTTP server
  ${t.cmd("mcp add")} ${t.dim("<name> <url> --sse")}      Add SSE server
  ${t.cmd("mcp remove")} ${t.dim("<name>")}               Remove a server
  ${t.cmd("mcp enable")} ${t.dim("<name>")}               Enable a disabled server
  ${t.cmd("mcp disable")} ${t.dim("<name>")}              Disable a server
  ${t.cmd("mcp reload")} ${t.dim("<name>")}               Reconnect server (live if agent is running)
  ${t.cmd("mcp env")} ${t.dim("<name> <KEY> <value>")}    Set env var for a server

  ${t.cmd("sandbox show")}                     Show current filesystem access rules
  ${t.cmd("sandbox add")} ${t.dim("<path>")}               Allow agent to access a directory
  ${t.cmd("sandbox remove")} ${t.dim("<path>")}            Remove a directory from allowed list
  ${t.cmd("sandbox block")} ${t.dim("<path>")}             Always block a directory (even if allowed)
  ${t.cmd("sandbox unblock")} ${t.dim("<path>")}           Remove a directory from blocked list
  ${t.cmd("sandbox restrict")}                 Enforce path limits in shell commands too
  ${t.cmd("sandbox unrestrict")}               Remove shell command path enforcement
  ${t.cmd("sandbox clear")}                    Remove all path limits (global mode)

  ${t.cmd("tenant list")}                      List all tenants with stats
  ${t.cmd("tenant show")} ${t.dim("<id>")}                 Show full tenant config
  ${t.cmd("tenant set")} ${t.dim("<id> <key> <value>")}    Update a tenant setting
  ${t.cmd("tenant plan")} ${t.dim("<id> <free|pro|admin>")}  Set tenant plan
  ${t.cmd("tenant suspend")} ${t.dim("<id> [reason]")}     Suspend a tenant (blocks all tasks)
  ${t.cmd("tenant unsuspend")} ${t.dim("<id>")}            Unsuspend a tenant
  ${t.cmd("tenant reset")} ${t.dim("<id>")}                Reset tenant config (keep cost history)
  ${t.cmd("tenant delete")} ${t.dim("<id>")}               Delete a tenant record
  ${t.cmd("tenant apikey set")} ${t.dim("<id> <KEY> <val>")}  Store encrypted AI provider key (OPENAI_API_KEY, etc.)
  ${t.cmd("tenant apikey delete")} ${t.dim("<id> <KEY>")}  Delete a tenant API key
  ${t.cmd("tenant apikey list")} ${t.dim("<id>")}          List tenant API key names (not values)
  ${t.cmd("tenant channel set")} ${t.dim("<id> <key> <val>")}  Store encrypted outbound channel credential
  ${t.cmd("tenant channel unset")} ${t.dim("<id> <key>")}  Remove a channel credential
  ${t.cmd("tenant channel list")} ${t.dim("<id>")}         List stored channel credential keys
  ${t.muted("  channel keys: email  email_password  resend_api_key  resend_from")}

  ${t.cmd("doctor")}                           Security audit - check for misconfigurations

  ${t.cmd("help")}                             Show this help

  ${t.bold("EXAMPLES")}
  ${dimLine}
  ${t.dim("$")} daemora setup
  ${t.dim("$")} daemora start
  ${t.dim("$")} daemora daemon install
  ${t.dim("$")} daemora vault set mypass123 OPENAI_API_KEY sk-...
  ${t.dim("$")} daemora vault list mypass123
  ${t.dim("$")} daemora mcp list
  ${t.dim("$")} daemora mcp add github npx -y @modelcontextprotocol/server-github
  ${t.dim("$")} daemora mcp env github GITHUB_PERSONAL_ACCESS_TOKEN ghp_...
  ${t.dim("$")} daemora mcp add notion http://localhost:3100/mcp
  ${t.dim("$")} daemora mcp add myserver http://localhost:3100/sse --sse
  ${t.dim("$")} daemora mcp remove github
  ${t.dim("$")} daemora mcp add                   (interactive - prompts for everything)
  ${t.dim("$")} daemora mcp reload github         (reconnects live if agent running)
  ${t.dim("$")} daemora sandbox add ~/Downloads   (lock agent to Downloads folder)
  ${t.dim("$")} daemora sandbox block ~/Downloads/private
  ${t.dim("$")} daemora sandbox show
  ${t.dim("$")} daemora sandbox clear             (back to global mode)
  ${t.dim("$")} daemora tenant list
  ${t.dim("$")} daemora tenant show telegram:123456789
  ${t.dim("$")} daemora tenant plan telegram:123456789 pro
  ${t.dim("$")} daemora tenant set telegram:123456789 model anthropic:claude-opus-4-6
  ${t.dim("$")} daemora tenant suspend telegram:999 "Terms of service violation"
  ${t.dim("$")} daemora tenant unsuspend telegram:999
  ${t.dim("$")} daemora tenant apikey set telegram:123 OPENAI_API_KEY sk-...
  ${t.dim("$")} daemora tenant apikey list telegram:123
  ${t.dim("$")} daemora tenant apikey delete telegram:123 OPENAI_API_KEY
  ${t.dim("$")} daemora tenant channel set telegram:123 resend_api_key re_xxx
  ${t.dim("$")} daemora tenant channel set telegram:123 resend_from you@yourdomain.com
  ${t.dim("$")} daemora tenant channel set telegram:123 email you@gmail.com
  ${t.dim("$")} daemora tenant channel set telegram:123 email_password xxxx-xxxx-xxxx-xxxx
  ${t.dim("$")} daemora tenant channel list telegram:123
  ${t.dim("$")} daemora tenant channel unset telegram:123 email_password
  ${t.dim("$")} daemora doctor
`);
}

main().catch((err) => {
  console.error(`\n  ${S.cross}  ${t.error(err.message)}\n`);
  process.exit(1);
});
