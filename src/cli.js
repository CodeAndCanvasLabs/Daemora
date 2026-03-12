#!/usr/bin/env -S node --disable-warning=ExperimentalWarning

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
import { config, reloadFromDb } from "./config/default.js";
import daemonManager from "./daemon/DaemonManager.js";
import secretVault from "./safety/SecretVault.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { randomBytes } from "crypto";
import { CHANNEL_DEFS, isChannelConfigured } from "./channels/channelDefs.js";

// ── Color palette — matches Daemora UI exactly ──────────────────────────────
const P = {
  cyan:   "#00d9ff",   // primary brand (cyan)
  teal:   "#4ECDC4",   // secondary accent (teal)
  red:    "#ff4458",   // danger / features (logo horns color)
  green:  "#00ff88",   // success / security
  amber:  "#ffaa00",   // warning / [NEW] badges
  muted:  "#64748b",   // slate-500
  dim:    "#94a3b8",   // slate-400
  border: "#1f1f2e",   // border color
  // semantic aliases
  get brand()   { return this.cyan; },
  get accent()  { return this.teal; },
  get success() { return this.green; },
  get warning() { return this.amber; },
  get error()   { return this.red; },
};

const t = {
  brand:   (s) => chalk.hex(P.cyan)(s),
  accent:  (s) => chalk.hex(P.teal)(s),
  success: (s) => chalk.hex(P.green)(s),
  warning: (s) => chalk.hex(P.amber)(s),
  error:   (s) => chalk.hex(P.red)(s),
  muted:   (s) => chalk.hex(P.muted)(s),
  dim:     (s) => chalk.hex(P.dim)(s),
  bold:    (s) => chalk.bold(s),
  h:       (s) => chalk.bold.hex(P.cyan)(s),
  h2:      (s) => chalk.bold.hex(P.teal)(s),
  cmd:     (s) => chalk.hex(P.teal)(s),
  new:     (s) => chalk.hex(P.amber)(s),
};

const S = {
  check:   chalk.hex(P.green)("\u2714"),
  cross:   chalk.hex(P.red)("\u2718"),
  arrow:   chalk.hex(P.cyan)("\u25B8"),
  dot:     chalk.hex(P.muted)("\u00B7"),
  bar:     chalk.hex(P.muted)("\u2502"),
  info:    chalk.hex(P.teal)("\u25C6"),
  lock:    chalk.hex(P.amber)("\u25A3"),
  eye:     chalk.hex(P.red)("\u25C9"),
  star:    chalk.hex(P.amber)("\u2605"),
};

const [,, command, subcommand, ...rest] = process.argv;

async function main() {
  switch (command) {
    case "version":
    case "--version":
    case "-v": {
      const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf-8"));
      console.log(`daemora v${pkg.version}`);
      break;
    }

    case "start": {
      // Block start if setup has not been completed
      try {
        const { configStore } = await import("./config/ConfigStore.js");
        if (!configStore.get("SETUP_COMPLETED")) {
          console.log(`\n  ${S.cross}  ${t.error("Setup not completed.")}`);
          console.log(`\n  Run ${t.cmd("daemora setup")} first to configure your agent.\n`);
          process.exit(1);
        }
      } catch {
        // DB not initialized — setup definitely not done
        console.log(`\n  ${S.cross}  ${t.error("Setup not completed.")}`);
        console.log(`\n  Run ${t.cmd("daemora setup")} first to configure your agent.\n`);
        process.exit(1);
      }

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

      // Reload non-secret config from SQLite (channel tokens, model settings, etc.)
      // This runs after vault inject so SQLite config overrides .env for everything.
      await reloadFromDb();

      // Block start if no AI provider is configured
      // Check: at least one provider key or Ollama host must be set
      const providerKeys = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_AI_API_KEY", "OLLAMA_HOST"];
      const hasProvider = providerKeys.some(k => {
        const v = process.env[k];
        return v && v.trim() && !v.includes("your_") && !v.includes("sk-xxx");
      });
      if (!hasProvider) {
        console.log(`\n  ${S.cross}  ${t.error("No AI provider configured.")}`);
        console.log(`\n  Daemora needs at least one AI provider to run.`);
        console.log(`  Run ${t.cmd("daemora setup")} to configure your provider and API keys.\n`);
        console.log(`  ${t.dim("Or set one manually:")}`);
        console.log(`    ${t.dim("export OPENAI_API_KEY=sk-...")}`)
        console.log(`    ${t.dim("export ANTHROPIC_API_KEY=sk-...")}`)
        console.log(`    ${t.dim("export OLLAMA_HOST=http://localhost:11434")}\n`);
        process.exit(1);
      }

      await import("./index.js");
      break;
    }

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

    case "cleanup":
      await handleCleanup(subcommand, rest);
      break;

    case "channels":
      await handleChannels(subcommand);
      break;

    case "models":
      await handleModels();
      break;

    case "tools":
      await handleTools(subcommand);
      break;

    case "config":
      handleConfig(subcommand, rest);
      break;

    case "auth":
      handleAuth(subcommand);
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
            pi.log.info(`  Tip: use \${MY_VAR} to reference existing env vars instead of pasting secrets`);
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
        // Detect URLs that were truncated by shell (& splits in zsh/bash)
        if (commandOrUrl.includes("?") && !commandOrUrl.includes("&") && restArgs.some(a => a.includes("="))) {
          console.error(`\n  ${S.cross}  URL appears truncated by the shell. Wrap it in quotes:`);
          console.error(`  ${S.arrow}  daemora mcp add ${name} "${commandOrUrl}&${restArgs.filter(a => a.includes("=")).join("&")}"\n`);
          process.exit(1);
        }
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

// ── Config (env var management from CLI) ──────────────────────────────────────

function handleConfig(action, args) {
  const header = `\n  ${t.h("Daemora Config")}  ${t.muted("Environment variable management")}\n`;

  switch (action) {
    case "set": {
      const [key, ...valueParts] = args;
      const value = valueParts.join(" ");
      if (!key || !value) {
        console.error(`\n  ${S.cross}  Usage: daemora config set ${t.dim("<KEY> <value>")}\n`);
        console.log(`  ${t.muted("Example:")}  daemora config set OPENAI_API_KEY sk-...\n`);
        process.exit(1);
      }
      writeEnvKey(key, value);
      process.env[key] = value;
      console.log(`${header}  ${S.check}  ${t.success(key)} = ${t.muted(value.length <= 8 ? value : value.slice(0, 4) + "****")}\n`);
      break;
    }
    case "get": {
      const [key] = args;
      if (!key) {
        console.error(`\n  ${S.cross}  Usage: daemora config get ${t.dim("<KEY>")}\n`);
        process.exit(1);
      }
      const env = readEnvFile();
      const val = env[key];
      if (val !== undefined) {
        const masked = val.length <= 4 ? "****" : val.slice(0, 4) + "*".repeat(Math.min(val.length - 4, 20));
        console.log(`${header}  ${key} = ${t.muted(masked)}\n`);
      } else {
        console.log(`${header}  ${S.cross}  ${key} is not set\n`);
      }
      break;
    }
    case "delete":
    case "unset": {
      const [key] = args;
      if (!key) {
        console.error(`\n  ${S.cross}  Usage: daemora config unset ${t.dim("<KEY>")}\n`);
        process.exit(1);
      }
      deleteEnvKey(key);
      delete process.env[key];
      console.log(`${header}  ${S.check}  ${key} removed\n`);
      break;
    }
    case "list":
    default: {
      const env = readEnvFile();
      const keys = Object.keys(env);
      console.log(header);
      if (keys.length === 0) {
        console.log(`  ${t.muted("No env vars configured. Run:")}  daemora config set <KEY> <value>\n`);
      } else {
        // Also read .env.example for available keys
        const examplePath = join(config.rootDir, ".env.example");
        const availableKeys = new Set();
        if (existsSync(examplePath)) {
          for (const line of readFileSync(examplePath, "utf-8").split("\n")) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) continue;
            const eqIdx = trimmed.indexOf("=");
            if (eqIdx > 0) availableKeys.add(trimmed.slice(0, eqIdx));
          }
        }

        // Show configured keys
        console.log(`  ${t.muted("Configured")}  (${keys.length} keys)\n`);
        for (const key of keys) {
          const val = env[key];
          const masked = !val ? t.dim("(empty)") : val.length <= 4 ? "****" : val.slice(0, 4) + "*".repeat(Math.min(val.length - 4, 16));
          console.log(`  ${S.check}  ${t.success(key.padEnd(30))} ${t.muted(masked)}`);
        }

        // Show unconfigured keys from .env.example
        const unconfigured = [...availableKeys].filter(k => !env[k]);
        if (unconfigured.length > 0) {
          console.log(`\n  ${t.muted("Available (not set)")}  (${unconfigured.length} keys)\n`);
          for (const key of unconfigured.slice(0, 20)) {
            console.log(`  ${S.cross}  ${t.dim(key)}`);
          }
          if (unconfigured.length > 20) {
            console.log(`  ${t.dim(`... and ${unconfigured.length - 20} more`)}`);
          }
        }
        console.log("");
      }
      break;
    }
  }
}

// ── Auth (API token management) ───────────────────────────────────────────────

function handleAuth(action) {
  const tokenPath = join(config.dataDir, "auth-token");
  const header = `\n  ${t.h("Daemora Auth")}  ${t.muted("API token management")}\n`;

  switch (action) {
    case "token": {
      if (!existsSync(tokenPath)) {
        console.log(`${header}  ${S.cross}  No token yet. Start the server first or run: daemora auth reset\n`);
      } else {
        const token = readFileSync(tokenPath, "utf-8").trim();
        console.log(`${header}  ${t.muted("API Token:")}\n\n  ${token}\n`);
        console.log(`  ${t.muted("Usage:")}  curl -H "Authorization: Bearer ${token.slice(0, 8)}..." http://localhost:${config.port}/api/health\n`);
      }
      break;
    }
    case "reset": {
      const token = randomBytes(32).toString("hex");
      mkdirSync(dirname(tokenPath), { recursive: true });
      writeFileSync(tokenPath, token, { mode: 0o600 });
      console.log(`${header}  ${S.check}  ${t.success("New token generated")}\n\n  ${token}\n`);
      console.log(`  ${t.muted("Restart the server for the new token to take effect.")}\n`);
      break;
    }
    default: {
      console.log(`${header}  ${t.cmd("daemora auth token")}    Show current API token`);
      console.log(`  ${t.cmd("daemora auth reset")}    Generate a new token\n`);
      break;
    }
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
      if (!newPath.startsWith("/") && !newPath.match(/^[A-Za-z]:[\\\/]/)) {
        console.error(`\n  ${S.cross}  Path must be absolute (start with / or C:\\)\n`);
        process.exit(1);
      }
      if (/[\x00-\x1f]/.test(newPath) || newPath.includes("\0")) {
        console.error(`\n  ${S.cross}  Path must not contain control characters or null bytes.\n`);
        process.exit(1);
      }
      if (/(^|[\\/])\.\.([\\/]|$)/.test(newPath)) {
        console.error(`\n  ${S.cross}  Path must not contain ".." traversal.\n`);
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
      if (/[\x00-\x1f]/.test(blockPath) || /(^|[\\/])\.\.([\\/]|$)/.test(blockPath)) {
        console.error(`\n  ${S.cross}  Invalid path — no control characters or ".." traversal allowed.\n`);
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

  // Read auth token for API calls
  const tokenPath = join(config.dataDir, "auth-token");
  const authToken = existsSync(tokenPath) ? readFileSync(tokenPath, "utf-8").trim() : "";

  async function apiCall(method, path, body) {
    const { default: http } = await import("http");
    // Ensure path starts with /api/
    const apiPath = path.startsWith("/api/") ? path : `/api${path}`;
    return new Promise((resolve, reject) => {
      const opts = {
        hostname: "localhost",
        port: parseInt(port),
        path: apiPath,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(authToken ? { "Authorization": `Bearer ${authToken}` } : {}),
        },
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
        if (t2.tools?.length) console.log(`  ${S.bar}  Allowed tools  ${t.success(t2.tools.join(", "))}`);
        if (t2.blockedTools?.length) console.log(`  ${S.bar}  Blocked tools  ${t.error(t2.blockedTools.join(", "))}`);
        if (t2.mcpServers?.length) console.log(`  ${S.bar}  MCP servers    ${t.accent(t2.mcpServers.join(", "))}`);
        if (t2.ownMcpServers && Object.keys(t2.ownMcpServers).length > 0) console.log(`  ${S.bar}  Own MCP        ${t.accent(Object.keys(t2.ownMcpServers).join(", "))}`);
        if (t2.modelRoutes) console.log(`  ${S.bar}  Model routes   ${t.dim(JSON.stringify(t2.modelRoutes))}`);
        if (t2.allowedPaths?.length) console.log(`  ${S.bar}  Allowed paths  ${t.dim(t2.allowedPaths.join(", "))}`);
        if (t2.blockedPaths?.length) console.log(`  ${S.bar}  Blocked paths  ${t.dim(t2.blockedPaths.join(", "))}`);
        if (t2.notes) console.log(`  ${S.bar}  Notes          ${t.muted(t2.notes)}`);
        console.log(`  ${S.bar}  Created        ${t.dim(t2.createdAt)}`);
        console.log(`  ${S.bar}  Last seen      ${t.dim(t2.lastSeenAt)}`);

        // Show linked channels
        if (t2.channels?.length) {
          console.log(`  ${S.bar}`);
          console.log(`  ${S.bar}  Linked channels:`);
          for (const ch of t2.channels) {
            console.log(`  ${S.bar}    ${t.accent(ch.channel)}:${t.bold(ch.user_id)}  ${t.dim(ch.linked_at || "")}`);
          }
        }

        // Show API key names
        if (t2.apiKeyNames?.length) {
          console.log(`  ${S.bar}`);
          console.log(`  ${S.bar}  API keys:`);
          for (const k of t2.apiKeyNames) {
            console.log(`  ${S.bar}    ${S.lock}  ${t.bold(k)}  ${t.dim("(encrypted)")}`);
          }
        }

        console.log("");
      } catch {
        console.error(`\n  ${S.cross}  Agent not running.\n`);
      }
      break;
    }

    case "create": {
      const [id] = args;
      if (!id) {
        console.error(`\n  ${S.cross}  Usage: daemora tenant create ${t.dim("<tenantId>")}`);
        console.error(`  ${t.muted("e.g. daemora tenant create telegram:123456789")}\n`);
        process.exit(1);
      }
      try {
        const res = await apiCall("POST", `/tenants`, { id });
        if (res.status === 409) { console.error(`\n  ${S.cross}  Tenant "${id}" already exists.\n`); process.exit(1); }
        console.log(`\n${header}  ${S.check}  Tenant ${t.bold(id)} created.\n`);
      } catch { console.error(`\n  ${S.cross}  Agent not running.\n`); }
      break;
    }

    case "set": {
      // daemora tenant set <tenantId> <key> <value>
      const [id, key, ...valueParts] = args;
      const value = valueParts.join(" ");
      if (!id || !key || !value) {
        console.error(`\n  ${S.cross}  Usage: daemora tenant set ${t.dim("<tenantId> <key> <value>")}`);
        console.error(`  ${t.muted("Keys:")}`);
        console.error(`    model              ${t.dim("— override model (e.g. openai:gpt-4o)")}`);
        console.error(`    plan               ${t.dim("— free | pro | admin")}`);
        console.error(`    maxCostPerTask     ${t.dim("— per-task cost limit (e.g. 0.50)")}`);
        console.error(`    maxDailyCost       ${t.dim("— daily budget (e.g. 5.00)")}`);
        console.error(`    tools              ${t.dim("— allowed tools (comma-separated, or 'none' to clear)")}`);
        console.error(`    blockedTools       ${t.dim("— blocked tools (comma-separated, or 'none' to clear)")}`);
        console.error(`    mcpServers         ${t.dim("— allowed MCP servers (comma-separated, or 'none' to clear)")}`);
        console.error(`    notes              ${t.dim("— free-text operator notes")}\n`);
        process.exit(1);
      }
      const body = {};
      const numericKeys = ["maxCostPerTask", "maxDailyCost"];
      const arrayKeys = ["tools", "blockedTools", "mcpServers"];
      if (numericKeys.includes(key)) {
        body[key] = parseFloat(value);
      } else if (arrayKeys.includes(key)) {
        body[key] = value === "none" ? null : value.split(",").map(s => s.trim()).filter(Boolean);
      } else {
        body[key] = value;
      }
      try {
        const res = await apiCall("PATCH", `/tenants/${encodeURIComponent(id)}`, body);
        if (res.status === 404) { console.error(`\n  ${S.cross}  Tenant "${id}" not found.\n`); process.exit(1); }
        const display = Array.isArray(body[key]) ? body[key].join(", ") : value;
        console.log(`\n${header}  ${S.check}  Tenant ${t.bold(id)}: ${t.accent(key)} = ${t.bold(display)}\n`);
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

    case "link": {
      // daemora tenant link <tenantId> <channel> <userId>
      const [linkId, linkChannel, linkUserId] = args;
      if (!linkId || !linkChannel || !linkUserId) {
        console.error(`\n  ${S.cross}  Usage: daemora tenant link ${t.dim("<tenantId> <channel> <userId>")}\n`);
        process.exit(1);
      }
      try {
        const res = await apiCall("POST", `/tenants/${encodeURIComponent(linkId)}/channels`, { channel: linkChannel, userId: linkUserId });
        if (res.status === 404) { console.error(`\n  ${S.cross}  Tenant "${linkId}" not found.\n`); process.exit(1); }
        if (res.status === 409) { console.error(`\n  ${S.cross}  ${res.body?.error || "Channel identity already linked to another tenant."}\n`); process.exit(1); }
        console.log(`\n${header}  ${S.check}  Linked ${t.bold(linkChannel + ":" + linkUserId)} → tenant ${t.bold(linkId)}.\n`);
      } catch { console.error(`\n  ${S.cross}  Agent not running.\n`); }
      break;
    }

    case "unlink": {
      // daemora tenant unlink <tenantId> <channel> <userId>
      const [unlinkId, unlinkChannel, unlinkUserId] = args;
      if (!unlinkId || !unlinkChannel || !unlinkUserId) {
        console.error(`\n  ${S.cross}  Usage: daemora tenant unlink ${t.dim("<tenantId> <channel> <userId>")}\n`);
        process.exit(1);
      }
      try {
        const res = await apiCall("DELETE", `/tenants/${encodeURIComponent(unlinkId)}/channels/${unlinkChannel}/${encodeURIComponent(unlinkUserId)}`);
        if (res.status === 404) { console.error(`\n  ${S.cross}  Tenant or channel identity not found.\n`); process.exit(1); }
        if (res.status === 400) { console.error(`\n  ${S.cross}  ${res.body?.error || "Cannot unlink last identity."}\n`); process.exit(1); }
        console.log(`\n${header}  ${S.check}  Unlinked ${t.bold(unlinkChannel + ":" + unlinkUserId)} from tenant ${t.bold(unlinkId)}.\n`);
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

    case "workspace": {
      // daemora tenant workspace <tenantId>                 — show paths
      // daemora tenant workspace <tenantId> add <path>      — add to allowedPaths
      // daemora tenant workspace <tenantId> remove <path>   — remove from allowedPaths
      // daemora tenant workspace <tenantId> block <path>    — add to blockedPaths
      // daemora tenant workspace <tenantId> unblock <path>  — remove from blockedPaths
      const [tenantId, wsAction, wsPath] = args;
      if (!tenantId) {
        console.error(`\n  ${S.cross}  Usage: daemora tenant workspace ${t.dim("<tenantId> [add|remove|block|unblock] [path]")}\n`);
        process.exit(1);
      }

      const { default: tm } = await import("./tenants/TenantManager.js");
      const tenant = tm.get(tenantId);
      if (!tenant) {
        console.error(`\n  ${S.cross}  Tenant "${tenantId}" not found.\n`);
        process.exit(1);
      }

      if (!wsAction) {
        // Show current workspace paths
        console.log(header);
        console.log(`  ${S.bar}  Tenant         ${t.bold(tenantId)}`);
        console.log(`  ${S.bar}  Workspace      ${t.dim(tm.getWorkspace(tenantId))}`);
        const allowed = tenant.allowedPaths || [];
        const blocked = tenant.blockedPaths || [];
        if (allowed.length > 0) {
          console.log(`  ${S.bar}  Allowed paths:`);
          for (const p of allowed) console.log(`  ${S.bar}    ${S.check}  ${p}`);
        } else {
          console.log(`  ${S.bar}  Allowed paths  ${t.muted("(none — uses global or workspace default)")}`);
        }
        if (blocked.length > 0) {
          console.log(`  ${S.bar}  Blocked paths:`);
          for (const p of blocked) console.log(`  ${S.bar}    ${S.cross}  ${p}`);
        } else {
          console.log(`  ${S.bar}  Blocked paths  ${t.muted("(none)")}`);
        }
        console.log("");
        break;
      }

      // Validate path is absolute
      if (["add", "remove", "block", "unblock"].includes(wsAction)) {
        if (!wsPath) {
          console.error(`\n  ${S.cross}  Usage: daemora tenant workspace ${tenantId} ${wsAction} ${t.dim("<absolute-path>")}\n`);
          process.exit(1);
        }
        if (!wsPath.startsWith("/") && !/^[A-Za-z]:\\/.test(wsPath)) {
          console.error(`\n  ${S.cross}  Path must be absolute (start with / or C:\\)\n`);
          process.exit(1);
        }
      }

      try {
        if (wsAction === "add") {
          const updated = [...new Set([...(tenant.allowedPaths || []), wsPath])];
          tm.set(tenantId, { allowedPaths: updated });
          console.log(`\n${header}  ${S.check}  ${t.bold(wsPath)} added to allowedPaths for ${t.bold(tenantId)}\n`);
        } else if (wsAction === "remove") {
          const updated = (tenant.allowedPaths || []).filter(p => p !== wsPath);
          if (updated.length === (tenant.allowedPaths || []).length) {
            console.error(`\n  ${S.cross}  "${wsPath}" not found in allowedPaths.\n`);
            process.exit(1);
          }
          tm.set(tenantId, { allowedPaths: updated });
          console.log(`\n${header}  ${S.check}  ${t.bold(wsPath)} removed from allowedPaths for ${t.bold(tenantId)}\n`);
        } else if (wsAction === "block") {
          const updated = [...new Set([...(tenant.blockedPaths || []), wsPath])];
          tm.set(tenantId, { blockedPaths: updated });
          console.log(`\n${header}  ${S.check}  ${t.bold(wsPath)} added to blockedPaths for ${t.bold(tenantId)}\n`);
        } else if (wsAction === "unblock") {
          const updated = (tenant.blockedPaths || []).filter(p => p !== wsPath);
          if (updated.length === (tenant.blockedPaths || []).length) {
            console.error(`\n  ${S.cross}  "${wsPath}" not found in blockedPaths.\n`);
            process.exit(1);
          }
          tm.set(tenantId, { blockedPaths: updated });
          console.log(`\n${header}  ${S.check}  ${t.bold(wsPath)} removed from blockedPaths for ${t.bold(tenantId)}\n`);
        } else {
          console.error(`\n  ${S.cross}  Unknown workspace action: ${wsAction}`);
          console.log(`  ${t.muted("Usage:")} daemora tenant workspace ${t.dim("<id> [add|remove|block|unblock] <path>")}\n`);
          process.exit(1);
        }
      } catch (err) {
        console.error(`\n  ${S.cross}  ${err.message}\n`);
        process.exit(1);
      }
      break;
    }

    default:
      console.error(`\n  ${S.cross}  Unknown tenant command: ${action || "(none)"}`);
      console.log(`  ${t.muted("Usage:")} daemora tenant ${t.dim("[list|show|create|set|plan|suspend|unsuspend|reset|delete|link|unlink|apikey|channel|workspace]")}\n`);
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

// ─── Cleanup ──────────────────────────────────────────────────────────────────

async function handleCleanup(subcommand, rest) {
  const { runCleanup, getStorageStats } = await import("./services/cleanup.js");
  const { readFileSync: rfs, writeFileSync: wfs, existsSync: exs } = await import("fs");
  const { join: pjoin } = await import("path");

  if (subcommand === "stats") {
    const stats = getStorageStats();
    console.log(`\n  ${t.h("Storage Stats")}\n`);
    console.log(`  Tasks:    ${t.bold(stats.tasks.files)} files  (${stats.tasks.sizeKB} KB)`);
    console.log(`  Audit:    ${t.bold(stats.audit.files)} files  (${stats.audit.sizeKB} KB)`);
    console.log(`  Costs:    ${t.bold(stats.costs.files)} files  (${stats.costs.sizeKB} KB)`);
    console.log(`  Sessions: ${t.bold(stats.sessions.files)} files  (${stats.sessions.sizeKB} KB)`);
    console.log(`\n  Retention: ${stats.retentionDays === "never" ? t.dim("never delete") : t.bold(stats.retentionDays + " days")}`);
    console.log(`  ${t.dim("Set with: daemora cleanup set <days>  (0 = never)")}\n`);
    return;
  }

  if (subcommand === "set") {
    const days = parseInt(rest[0], 10);
    if (isNaN(days) || days < 0) {
      console.log(`\n  ${S.cross}  Usage: daemora cleanup set <days>  (0 = never delete)\n`);
      return;
    }

    // Update .env file
    const envPath = pjoin(config.rootDir, ".env");
    if (exs(envPath)) {
      let env = rfs(envPath, "utf-8");
      if (env.includes("CLEANUP_AFTER_DAYS=")) {
        env = env.replace(/CLEANUP_AFTER_DAYS=\d*/, `CLEANUP_AFTER_DAYS=${days}`);
      } else {
        env = env.trimEnd() + `\n\n# === Cleanup ===\nCLEANUP_AFTER_DAYS=${days}\n`;
      }
      wfs(envPath, env);
    } else {
      wfs(envPath, `CLEANUP_AFTER_DAYS=${days}\n`);
    }

    if (days === 0) {
      console.log(`\n  ${t.success("✔")}  Auto-cleanup ${t.bold("disabled")}. Data will be kept forever.\n`);
    } else {
      console.log(`\n  ${t.success("✔")}  Auto-cleanup set to ${t.bold(days + " days")}. Old data deleted on each startup.\n`);
    }
    return;
  }

  // Default: run cleanup now
  const days = config.cleanupAfterDays || 30;
  console.log(`\n  ${t.h("Cleanup")}  ${t.muted(`Deleting data older than ${days} days`)}\n`);

  const result = runCleanup(days);

  if (result.total === 0) {
    console.log(`  ${t.success("✔")}  Nothing to clean up.\n`);
  } else {
    if (result.tasks > 0)    console.log(`  ${t.success("✔")}  Tasks:    ${result.tasks} deleted`);
    if (result.audit > 0)    console.log(`  ${t.success("✔")}  Audit:    ${result.audit} deleted`);
    if (result.costs > 0)    console.log(`  ${t.success("✔")}  Costs:    ${result.costs} deleted`);
    if (result.sessions > 0) console.log(`  ${t.success("✔")}  Sessions: ${result.sessions} deleted`);
    console.log(`\n  Total: ${t.bold(result.total)} file(s) deleted.\n`);
  }
}

// ─── Channels ─────────────────────────────────────────────────────────────────

async function handleChannels(sub) {
  if (sub === "add") {
    await handleChannelAdd(rest[0]);
    return;
  }

  // Default: info viewer
  const { select, isCancel } = await import("@clack/prompts");
  const w = 67;
  const line    = chalk.hex(P.cyan)("━".repeat(w));
  const rowLine = chalk.hex(P.border)("─".repeat(w));

  const configured   = CHANNEL_DEFS.filter(c => {
    const key = c.envRequired[0].split("=")[0];
    return !!process.env[key] || c.envRequired[0].includes("=true") && process.env[key] === "true";
  });

  // ── Header ────────────────────────────────────────────────────────────────
  console.log(`\n${line}`);
  console.log(`  ${chalk.bold.hex(P.cyan)("Daemora Channels")}  ${chalk.hex(P.muted)(CHANNEL_DEFS.length + " supported · " + configured.length + " configured")}`);
  console.log(rowLine);

  while (true) {
    console.log();
    const options = CHANNEL_DEFS.map(ch => {
      const isConfigured = ch.envRequired.every(e => {
        const [k, v] = e.split("=");
        return v ? process.env[k] === v : !!process.env[k];
      });
      const badge = isConfigured ? chalk.hex(P.green)("✔") : chalk.hex(P.border)("○");
      return {
        value: ch.name,
        label: `${badge}  ${(isConfigured ? chalk.bold.hex(P.teal) : chalk.hex(P.dim))(ch.label.padEnd(20))}  ${chalk.hex(P.muted)(ch.desc)}`,
      };
    });
    options.push({ value: "exit", label: `${chalk.hex(P.muted)("─")}  Exit` });

    const choice = await select({
      message: chalk.hex(P.cyan)("Select a channel for full setup details"),
      options,
    });

    if (isCancel(choice) || choice === "exit") break;

    const ch = CHANNEL_DEFS.find(c => c.name === choice);
    if (!ch) continue;

    const isConfigured = ch.envRequired.every(e => {
      const [k, v] = e.split("=");
      return v ? process.env[k] === v : !!process.env[k];
    });

    console.log(`\n${rowLine}`);
    console.log(`  ${isConfigured ? chalk.hex(P.green)("✔") : chalk.hex(P.border)("○")}  ${chalk.bold.hex(P.cyan)(ch.label)}  ${chalk.hex(P.muted)(ch.desc)}`);
    console.log(`  ${rowLine}`);

    // Required env vars
    console.log(`\n  ${chalk.bold.hex(P.teal)("Required env vars")}`);
    for (const env of ch.envRequired) {
      const [k] = env.split("=");
      const set = process.env[k];
      const status = set ? chalk.hex(P.green)("✔ set") : chalk.hex(P.red)("✘ not set");
      console.log(`  ${S.bar}  ${chalk.hex(P.amber)(env.padEnd(38))}  ${status}`);
    }

    // Optional env vars
    if (ch.envOptional.length > 0) {
      console.log(`\n  ${chalk.bold.hex(P.teal)("Optional env vars")}`);
      for (const [env, desc] of ch.envOptional) {
        const set = process.env[env];
        const val = set ? chalk.hex(P.green)("✔ " + set.slice(0, 30) + (set.length > 30 ? "…" : "")) : chalk.hex(P.border)("not set");
        console.log(`  ${S.bar}  ${chalk.hex(P.dim)(env.padEnd(38))}  ${val}`);
        console.log(`     ${" ".repeat(38)}  ${chalk.hex(P.border)(desc)}`);
      }
    }

    // Setup steps
    console.log(`\n  ${chalk.bold.hex(P.teal)("Setup")}`);
    for (const line of ch.setup) {
      console.log(`  ${S.arrow}  ${chalk.hex(P.dim)(line)}`);
    }

    // Tenant configuration
    console.log(`\n  ${chalk.bold.hex(P.teal)("Tenant / per-user config")}`);
    console.log(`  ${S.bar}  ${chalk.hex(P.muted)("View tenants on this channel:")}`);
    console.log(`     ${chalk.hex(P.teal)("daemora tenant list")}  ${chalk.hex(P.border)("(then filter by " + ch.name + ":)")}`);
    console.log(`  ${S.bar}  ${chalk.hex(P.muted)("Set per-tenant model override:")}`);
    console.log(`     ${chalk.hex(P.teal)("daemora tenant set " + ch.tenantKey + ":<userId> model anthropic:claude-sonnet-4-6")}`);
    console.log(`  ${S.bar}  ${chalk.hex(P.muted)("Set per-tenant cost limit:")}`);
    console.log(`     ${chalk.hex(P.teal)("daemora tenant set " + ch.tenantKey + ":<userId> maxDailyCost 1.00")}`);
    console.log(`  ${S.bar}  ${chalk.hex(P.muted)("Give tenant their own API key:")}`);
    console.log(`     ${chalk.hex(P.teal)("daemora tenant apikey set " + ch.tenantKey + ":<userId> OPENAI_API_KEY sk-...")}`);
    console.log(`  ${S.bar}  ${chalk.hex(P.muted)("Suspend a tenant:")}`);
    console.log(`     ${chalk.hex(P.teal)("daemora tenant suspend " + ch.tenantKey + ":<userId> \"reason\"")}`);
    console.log(`  ${S.bar}  ${chalk.hex(P.muted)("Store outbound channel credential:")}`);
    console.log(`     ${chalk.hex(P.teal)("daemora tenant channel set " + ch.tenantKey + ":<userId> resend_api_key re_xxx")}`);

    console.log(`\n${rowLine}\n`);
  }

  console.log(`  ${S.arrow}  ${chalk.hex(P.teal)("daemora channels add")}  to configure a new channel interactively`);
  console.log(`  ${S.arrow}  Edit ${chalk.hex(P.teal)(".env")} and restart to apply changes\n`);
}


// ─── Channel Add ─────────────────────────────────────────────────────────────

async function handleChannelAdd(channelName) {
  const p = await import("@clack/prompts");
  const w = 67;
  const rowLine = chalk.hex(P.border)("─".repeat(w));

  let ch;
  if (channelName) {
    ch = CHANNEL_DEFS.find(c => c.name === channelName.toLowerCase());
    if (!ch) {
      console.log(`\n  ${S.cross}  Unknown channel: ${chalk.bold(channelName)}`);
      console.log(`  ${S.arrow}  Available: ${CHANNEL_DEFS.map(c => t.accent(c.name)).join(", ")}\n`);
      return;
    }
  } else {
    // Interactive channel selection
    const options = CHANNEL_DEFS.map(c => {
      const configured = isChannelConfigured(c);
      const badge = configured ? chalk.hex(P.green)("✔") : chalk.hex(P.border)("○");
      return {
        value: c.name,
        label: `${badge}  ${(configured ? chalk.bold.hex(P.teal) : chalk.hex(P.dim))(c.label.padEnd(20))}  ${chalk.hex(P.muted)(c.desc)}`,
      };
    });

    const choice = await p.select({
      message: chalk.hex(P.cyan)("Select a channel to configure"),
      options,
    });
    if (p.isCancel(choice)) return;
    ch = CHANNEL_DEFS.find(c => c.name === choice);
    if (!ch) return;
  }

  // Platform check (e.g. iMessage = macOS only)
  if (ch.platformCheck && process.platform !== ch.platformCheck) {
    console.log(`\n  ${S.cross}  ${ch.label} requires ${ch.platformCheck}. Current platform: ${process.platform}\n`);
    return;
  }

  const configured = isChannelConfigured(ch);
  console.log(`\n${rowLine}`);
  console.log(`  ${configured ? chalk.hex(P.green)("✔ configured") : chalk.hex(P.amber)("○ not configured")}  ${chalk.bold.hex(P.cyan)(ch.label)}  ${chalk.hex(P.muted)(ch.desc)}`);
  console.log(rowLine);

  // Show setup instructions
  p.note(ch.setup.join("\n"), `${ch.label} Setup`);

  // Prompt for each env var
  if (!ch.prompts || ch.prompts.length === 0) {
    console.log(`  ${S.arrow}  No credentials needed — just set env vars in .env\n`);
    return;
  }

  const values = {};
  for (const prompt of ch.prompts) {
    const opts = { message: prompt.label };
    if (prompt.initialValue) opts.initialValue = prompt.initialValue;
    if (prompt.placeholder) opts.placeholder = prompt.placeholder;

    let val;
    if (prompt.type === "password") {
      val = await p.password(opts);
    } else {
      val = await p.text(opts);
    }
    if (p.isCancel(val)) return;
    if (val) values[prompt.key] = val;
  }

  // Handle subFlows (optional feature toggles)
  if (ch.subFlows) {
    for (const flow of ch.subFlows) {
      const enable = await p.confirm({ message: flow.confirm, initialValue: false });
      if (p.isCancel(enable)) return;
      if (enable) {
        for (const prompt of flow.prompts) {
          const opts = { message: prompt.label };
          if (prompt.initialValue) opts.initialValue = prompt.initialValue;
          if (prompt.placeholder) opts.placeholder = prompt.placeholder;
          const val = prompt.type === "password" ? await p.password(opts) : await p.text(opts);
          if (p.isCancel(val)) return;
          if (val) values[prompt.key] = val;
        }
      }
    }
  }

  // Write all values to .env
  let written = 0;
  for (const [key, value] of Object.entries(values)) {
    writeEnvKey(key, value);
    written++;
  }

  if (written > 0) {
    console.log(`\n  ${S.check}  ${chalk.bold.hex(P.green)(ch.label)} configured — ${written} env var(s) written to .env`);
    console.log(`  ${S.arrow}  Restart Daemora to activate: ${t.cmd("daemora start")}\n`);
  } else {
    console.log(`\n  ${S.arrow}  No values entered. Nothing written.\n`);
  }
}


// ─── Models ──────────────────────────────────────────────────────────────────

async function handleModels() {
  const { select, isCancel } = await import("@clack/prompts");
  const { models: modelRegistry } = await import("./config/models.js");
  const w = 67;
  const line    = chalk.hex(P.cyan)("━".repeat(w));
  const rowLine = chalk.hex(P.border)("─".repeat(w));

  // ── Build providers dynamically from model registry ─────────────────────
  const providerEnvKeys = {
    openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", google: "GOOGLE_AI_API_KEY",
    xai: "XAI_API_KEY", deepseek: "DEEPSEEK_API_KEY", mistral: "MISTRAL_API_KEY", ollama: null,
  };
  const providerNames = {
    openai: "OpenAI", anthropic: "Anthropic", google: "Google", xai: "xAI",
    deepseek: "DeepSeek", mistral: "Mistral", ollama: "Ollama (local)",
  };

  const providerMap = new Map();
  for (const [fullId, meta] of Object.entries(modelRegistry)) {
    const prov = meta.provider;
    if (!providerMap.has(prov)) {
      providerMap.set(prov, {
        name: providerNames[prov] || prov,
        prefix: prov,
        envKey: providerEnvKeys[prov] || `${prov.toUpperCase()}_API_KEY`,
        configured: prov === "ollama" ? true : undefined,
        models: [],
      });
    }
    const inputPrice = meta.costPer1kInput ? `$${(meta.costPer1kInput * 1000).toFixed(2)}` : null;
    const outputPrice = meta.costPer1kOutput ? `$${(meta.costPer1kOutput * 1000).toFixed(2)}` : null;
    const price = prov === "ollama" ? "free" : (inputPrice && outputPrice ? `${inputPrice}/${outputPrice}` : null);
    const ctx = meta.contextWindow ? `${Math.round(meta.contextWindow / 1000)}K ctx` : "";
    const caps = (meta.capabilities || []).filter(c => c !== "text" && c !== "tools").join(", ");
    const desc = [caps, ctx].filter(Boolean).join(" · ") || meta.model;
    providerMap.get(prov).models.push({ id: meta.model, desc, price });
  }
  const PROVIDERS = [...providerMap.values()];

  const routingRows = [
    ["DEFAULT_MODEL",  process.env.DEFAULT_MODEL  || chalk.hex(P.muted)("openai:gpt-4.1-mini (built-in default)")],
    ["CODE_MODEL",     process.env.CODE_MODEL     || chalk.hex(P.border)("not set — uses DEFAULT_MODEL")],
    ["RESEARCH_MODEL", process.env.RESEARCH_MODEL || chalk.hex(P.border)("not set — uses DEFAULT_MODEL")],
    ["WRITER_MODEL",   process.env.WRITER_MODEL   || chalk.hex(P.border)("not set — uses DEFAULT_MODEL")],
    ["ANALYST_MODEL",  process.env.ANALYST_MODEL  || chalk.hex(P.border)("not set — uses DEFAULT_MODEL")],
  ];

  function renderProvider(prov) {
    const configured = prov.configured || !!process.env[prov.envKey];
    const status = configured
      ? chalk.hex(P.green)("✔") + "  " + chalk.bold.hex(P.teal)(prov.name) + chalk.hex(P.muted)(`  [${prov.prefix}:]`) + chalk.hex(P.green)("  configured")
      : chalk.hex(P.red)("✘") + "  " + chalk.bold.hex(P.dim)(prov.name)   + chalk.hex(P.border)(` [${prov.prefix}:]`) + chalk.hex(P.border)("  not configured");

    console.log(`\n  ${status}`);
    if (!configured && prov.envKey) {
      console.log(`     ${chalk.hex(P.border)("env: ")}${chalk.hex(P.amber)(prov.envKey)}`);
    }
    console.log(`  ${chalk.hex(P.border)("─".repeat(65))}`);
    for (const m of prov.models) {
      const fullId  = `${prov.prefix}:${m.id}`;
      const newBadge = m.isNew ? chalk.hex(P.amber)(" [NEW]") : "";
      const priceTag = m.price ? chalk.hex(P.muted)(` ${m.price} /MTok`) : "";
      console.log(`  ${S.dot}  ${chalk.hex(P.teal)(fullId.padEnd(44))}${priceTag}${newBadge}`);
      console.log(`       ${chalk.hex(P.dim)(m.desc)}`);
    }
  }

  // ── Header ────────────────────────────────────────────────────────────────
  console.log(`\n${line}`);
  console.log(`  ${chalk.bold.hex(P.cyan)("Daemora Model Providers")}  ${chalk.hex(P.muted)(PROVIDERS.length + " providers · " + PROVIDERS.reduce((s,p) => s + p.models.length, 0) + " models")}`);
  console.log(rowLine);

  // ── Interactive provider browser ──────────────────────────────────────────
  while (true) {
    const choices = PROVIDERS.map(p => {
      const configured = p.configured || !!process.env[p.envKey];
      const badge = configured ? chalk.hex(P.green)("✔") : chalk.hex(P.border)("○");
      return {
        value: p.prefix,
        label: `${badge}  ${p.name.padEnd(18)} ${chalk.hex(P.muted)(p.models.length + " models")}`,
      };
    });
    choices.push({ value: "routing", label: `${S.star}  Task-Type Routing` });
    choices.push({ value: "exit",    label: `${chalk.hex(P.muted)("─")}  Exit` });

    console.log();
    const choice = await select({
      message: chalk.hex(P.cyan)("Select a provider to browse models"),
      options: choices,
    });

    if (isCancel(choice) || choice === "exit") break;

    if (choice === "routing") {
      console.log(`\n${rowLine}`);
      console.log(`  ${chalk.bold.hex(P.teal)("Task-Type Model Routing")}`);
      console.log(`  ${chalk.hex(P.border)("─".repeat(65))}`);
      for (const [k, v] of routingRows) {
        console.log(`  ${S.bar}  ${chalk.hex(P.muted)(k.padEnd(16))}  ${chalk.hex(P.teal)(String(v))}`);
      }
      console.log(`\n  ${chalk.hex(P.dim)("Set via env vars. Sub-agents auto-pick model by profile (coder/researcher/...)")}`);
      continue;
    }

    const prov = PROVIDERS.find(p => p.prefix === choice);
    if (prov) renderProvider(prov);
  }

  console.log(`\n${rowLine}`);
  console.log(`  ${S.arrow}  ${chalk.hex(P.teal)("daemora setup")}               choose provider interactively`);
  console.log(`  ${S.arrow}  ${chalk.hex(P.teal)("DEFAULT_MODEL=... daemora start")}  override at startup\n`);
}

// ─── Tools ────────────────────────────────────────────────────────────────────

async function handleTools(filter) {
  const { select, isCancel } = await import("@clack/prompts");
  const w = 67;
  const line    = chalk.hex(P.cyan)("━".repeat(w));
  const rowLine = chalk.hex(P.border)("─".repeat(w));

  const TOOLS = [
    { name: "readFile",             cat: "Files",        desc: "Read files from disk" },
    { name: "writeFile",            cat: "Files",        desc: "Write/create files" },
    { name: "editFile",             cat: "Files",        desc: "Edit files (search & replace)" },
    { name: "listDirectory",        cat: "Files",        desc: "List directory contents" },
    { name: "searchFiles",          cat: "Files",        desc: "Find files by name/pattern" },
    { name: "searchContent",        cat: "Files",        desc: "Search file content (ripgrep-style)" },
    { name: "glob",                 cat: "Files",        desc: "Glob file pattern matching" },
    { name: "grep",                 cat: "Files",        desc: "Regex search in files" },
    { name: "applyPatch",           cat: "Files",        desc: "Apply unified diff patches" },
    { name: "executeCommand",       cat: "System",       desc: "Run shell commands (sandboxed)" },
    { name: "sshTool",              cat: "System",       desc: "SSH remote exec & SCP file transfer" },
    { name: "database",             cat: "System",       desc: "Query SQLite / PostgreSQL / MySQL" },
    { name: "webFetch",             cat: "Web",          desc: "Fetch any URL content" },
    { name: "webSearch",            cat: "Web",          desc: "Search the web (SerpAPI/Brave)" },
    { name: "browserAction",        cat: "Web",          desc: "Browser automation (Playwright)" },
    { name: "googlePlaces",         cat: "Web",          desc: "Search places via Google Places API" },
    { name: "sendEmail",            cat: "Communication", desc: "Send emails via SMTP/Resend" },
    { name: "messageChannel",       cat: "Communication", desc: "Send message to any active channel" },
    { name: "makeVoiceCall",        cat: "Communication", desc: "Make voice calls (Twilio)" },
    { name: "iMessageTool",         cat: "Communication", desc: "Send/read iMessages (macOS)" },
    { name: "readPDF",              cat: "Media",        desc: "Extract text from PDF files" },
    { name: "generateImage",        cat: "Media",        desc: "Generate images (DALL-E 3)" },
    { name: "imageAnalysis",        cat: "Media",        desc: "Analyze images with vision AI" },
    { name: "transcribeAudio",      cat: "Media",        desc: "Transcribe audio files (Whisper)" },
    { name: "textToSpeech",         cat: "Media",        desc: "Convert text to speech (TTS)" },
    { name: "screenCapture",        cat: "Media",        desc: "Capture screen / screenshots" },
    { name: "sendFile",             cat: "Media",        desc: "Send files via channels" },
    { name: "createDocument",       cat: "Media",        desc: "Create formatted documents" },
    { name: "gitTool",              cat: "Dev",          desc: "Git operations (clone/commit/push/...)" },
    { name: "clipboard",            cat: "Dev",          desc: "Read/write system clipboard" },
    { name: "readMemory",           cat: "Memory",       desc: "Read agent memory file" },
    { name: "writeMemory",          cat: "Memory",       desc: "Write/update agent memory" },
    { name: "searchMemory",         cat: "Memory",       desc: "Semantic search in memory" },
    { name: "readDailyLog",         cat: "Memory",       desc: "Read daily activity log" },
    { name: "writeDailyLog",        cat: "Memory",       desc: "Append to daily log" },
    { name: "pruneMemory",          cat: "Memory",       desc: "Compact/prune old memories" },
    { name: "listMemoryCategories", cat: "Memory",       desc: "List memory categories" },
    { name: "spawnAgent",           cat: "Agents",       desc: "Spawn a sub-agent for a task" },
    { name: "parallelAgents",       cat: "Agents",       desc: "Spawn multiple agents in parallel" },
    { name: "delegateToAgent",      cat: "Agents",       desc: "Delegate to a remote A2A agent" },
    { name: "manageAgents",         cat: "Agents",       desc: "List/kill/steer running agents" },
    { name: "manageMCP",            cat: "MCP",          desc: "Manage MCP server connections" },
    { name: "useMCP",               cat: "MCP",          desc: "Call any MCP tool by name" },
    { name: "projectTracker",       cat: "Productivity", desc: "Track projects, tasks, milestones" },
    { name: "cron",                 cat: "Productivity", desc: "Schedule recurring tasks" },
    { name: "notification",         cat: "Productivity", desc: "Desktop/push notifications (ntfy/Pushover)" },
    { name: "calendar",             cat: "Productivity", desc: "Read/create calendar events (macOS/Google)" },
    { name: "contacts",             cat: "Productivity", desc: "Search macOS / Google contacts" },
    { name: "philipsHue",           cat: "Smart Home",   desc: "Control Philips Hue lights" },
    { name: "sonos",                cat: "Smart Home",   desc: "Control Sonos speakers" },
  ];

  // ── Header ────────────────────────────────────────────────────────────────
  console.log(`\n${line}`);
  console.log(`  ${chalk.bold.hex(P.cyan)("Daemora Tools")}  ${chalk.hex(P.muted)(TOOLS.length + " built-in tools")}`);
  console.log(rowLine);

  // ── Filter mode (daemora tools <keyword>) ─────────────────────────────────
  if (filter) {
    const fl = filter.toLowerCase();
    const results = TOOLS.filter(t =>
      t.name.toLowerCase().includes(fl) ||
      t.cat.toLowerCase().includes(fl) ||
      t.desc.toLowerCase().includes(fl),
    );
    console.log(`\n  ${chalk.hex(P.amber)("Filter:")} ${chalk.bold(filter)}  ${chalk.hex(P.muted)(results.length + " match" + (results.length !== 1 ? "es" : ""))}\n`);
    for (const tool of results) {
      console.log(`  ${S.dot}  ${chalk.hex(P.teal)(tool.name.padEnd(26))}  ${chalk.hex(P.dim)(tool.cat.padEnd(14))}  ${chalk.hex(P.muted)(tool.desc)}`);
    }
    console.log();
    return;
  }

  // ── Group by category ─────────────────────────────────────────────────────
  const byCategory = {};
  for (const tool of TOOLS) {
    (byCategory[tool.cat] = byCategory[tool.cat] || []).push(tool);
  }
  const categories = Object.keys(byCategory);

  // ── Interactive category browser ──────────────────────────────────────────
  while (true) {
    const catChoices = categories.map(cat => ({
      value: cat,
      label: `${chalk.hex(P.teal)(cat.padEnd(16))}  ${chalk.hex(P.muted)(byCategory[cat].length + " tools")}`,
    }));
    catChoices.push({ value: "all",  label: `${chalk.hex(P.cyan)("◆")}  All tools (${TOOLS.length})` });
    catChoices.push({ value: "exit", label: `${chalk.hex(P.muted)("─")}  Exit` });

    console.log();
    const choice = await select({
      message: chalk.hex(P.cyan)("Browse tools by category"),
      options: catChoices,
    });

    if (isCancel(choice) || choice === "exit") break;

    const toolList = choice === "all" ? TOOLS : byCategory[choice];

    console.log(`\n  ${chalk.bold.hex(P.teal)(choice === "all" ? "All Tools" : choice)}  ${chalk.hex(P.muted)("(" + toolList.length + ")")}`);
    console.log(`  ${chalk.hex(P.border)("─".repeat(65))}`);
    for (const tool of toolList) {
      const cat = choice === "all" ? chalk.hex(P.border)(tool.cat.padEnd(14) + "  ") : "";
      console.log(`  ${S.dot}  ${chalk.hex(P.teal)(tool.name.padEnd(26))}  ${cat}${chalk.hex(P.dim)(tool.desc)}`);
    }
  }

  console.log(`\n${rowLine}`);
  console.log(`  ${S.arrow}  ${chalk.hex(P.teal)("daemora tools Files")}        filter by category name`);
  console.log(`  ${S.arrow}  ${chalk.hex(P.teal)("daemora mcp list")}            see connected MCP server tools\n`);
}


function printHelp() {
  const w = 56;
  const line = chalk.hex(P.brand)("\u2501".repeat(w));
  const dimLine = chalk.hex(P.dim)("\u2500".repeat(w));

  console.log(`
${line}
  ${t.h("Daemora")}  ${t.muted("Your 24/7 AI Agent")}
${line}

  ${t.bold("USAGE")}
  ${dimLine}
  ${t.cmd("daemora")} ${t.dim("<command>")} ${t.dim("[options]")}

  ${t.bold("COMMANDS")}
  ${dimLine}
  ${t.cmd("start")}                            Start the agent server
  ${t.cmd("setup")}                            Interactive setup wizard

  ${t.cmd("auth token")}                        Show API auth token
  ${t.cmd("auth reset")}                        Generate a new auth token

  ${t.cmd("config list")}                      List all configured env vars
  ${t.cmd("config set")} ${t.dim("<KEY> <value>")}          Set an env var (e.g. OPENAI_API_KEY)
  ${t.cmd("config get")} ${t.dim("<KEY>")}                  Show an env var (masked)
  ${t.cmd("config unset")} ${t.dim("<KEY>")}                Remove an env var
  ${t.dim("  Keys: DEFAULT_MODEL, SUB_AGENT_MODEL, CODE_MODEL, RESEARCH_MODEL ...")}

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
  ${t.cmd("tenant show")} ${t.dim("<id>")}                 Show full tenant config + channels + API keys
  ${t.cmd("tenant create")} ${t.dim("<id>")}               Create a tenant manually (e.g. telegram:123)
  ${t.cmd("tenant set")} ${t.dim("<id> <key> <value>")}    Update a tenant setting
  ${t.muted("  keys: model  plan  maxCostPerTask  maxDailyCost  tools  blockedTools  mcpServers  notes")}
  ${t.muted("  arrays: comma-separated, 'none' to clear")}
  ${t.cmd("tenant plan")} ${t.dim("<id> <free|pro|admin>")}  Set tenant plan
  ${t.cmd("tenant suspend")} ${t.dim("<id> [reason]")}     Suspend a tenant (blocks all tasks)
  ${t.cmd("tenant unsuspend")} ${t.dim("<id>")}            Unsuspend a tenant
  ${t.cmd("tenant reset")} ${t.dim("<id>")}                Reset tenant config (keep cost history)
  ${t.cmd("tenant delete")} ${t.dim("<id>")}               Delete a tenant record
  ${t.cmd("tenant link")} ${t.dim("<id> <channel> <userId>")}   Link a channel identity to tenant
  ${t.cmd("tenant unlink")} ${t.dim("<id> <channel> <userId>")} Unlink a channel identity
  ${t.cmd("tenant apikey set")} ${t.dim("<id> <KEY> <val>")}  Store encrypted API key (per-tenant)
  ${t.cmd("tenant apikey delete")} ${t.dim("<id> <KEY>")}  Delete a tenant API key
  ${t.cmd("tenant apikey list")} ${t.dim("<id>")}          List tenant API key names (not values)
  ${t.cmd("tenant channel set")} ${t.dim("<id> <key> <val>")}  Store encrypted channel credential
  ${t.cmd("tenant channel unset")} ${t.dim("<id> <key>")}  Remove a channel credential
  ${t.cmd("tenant channel list")} ${t.dim("<id>")}         List stored channel credential keys
  ${t.cmd("tenant workspace")} ${t.dim("<id>")}             Show workspace + allowed/blocked paths
  ${t.cmd("tenant workspace")} ${t.dim("<id> add|remove|block|unblock <path>")}

  ${t.cmd("channels")}                          List all 19 supported channels + setup status
  ${t.cmd("channels add")} ${t.dim("[name]")}               Configure a new channel interactively
  ${t.cmd("models")}                            List all model providers + task-type routing
  ${t.cmd("tools")} ${t.dim("[filter]")}                    List all 50 built-in tools (filter by name/category)

  ${t.cmd("doctor")}                           Security audit - check for misconfigurations
  ${t.cmd("cleanup")}                          Delete old tasks, logs, and sessions
  ${t.cmd("cleanup set")} ${t.dim("<days>")}             Set auto-cleanup retention (0 = never)
  ${t.cmd("cleanup stats")}                    Show storage usage per directory

  ${t.cmd("version")}  ${t.dim("-v --version")}             Show version
  ${t.cmd("help")}                             Show this help

  ${t.bold("EXAMPLES")}
  ${dimLine}
  ${t.dim("$")} daemora channels
  ${t.dim("$")} daemora models
  ${t.dim("$")} daemora tools
  ${t.dim("$")} daemora tools Files
  ${t.dim("$")} daemora setup
  ${t.dim("$")} daemora start
  ${t.dim("$")} daemora daemon install
  ${t.dim("$")} daemora vault set mypass123 OPENAI_API_KEY sk-...
  ${t.dim("$")} daemora vault list mypass123
  ${t.dim("$")} daemora mcp list
  ${t.dim("$")} daemora mcp add github npx -y @modelcontextprotocol/server-github
  ${t.dim("$")} daemora mcp env github GITHUB_PERSONAL_ACCESS_TOKEN ghp_...
  ${t.dim("$")} daemora mcp env notion NOTION_TOKEN ntn_...
  ${t.dim("$")} daemora mcp env stripe STRIPE_SECRET_KEY sk_live_...
  ${t.dim("$")} daemora mcp enable notion
  ${t.dim("$")} daemora mcp add myserver "https://api.example.com/mcp?key=123&id=456"
  ${t.dim("$")} daemora mcp add mysse https://api.example.com/sse --sse
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
  ${t.dim("$")} daemora tenant workspace telegram:123
  ${t.dim("$")} daemora tenant workspace telegram:123 add /home/user/projects
  ${t.dim("$")} daemora tenant workspace telegram:123 block /home/user/private
  ${t.dim("$")} daemora doctor
`);
}

main().catch((err) => {
  console.error(`\n  ${S.cross}  ${t.error(err.message)}\n`);
  process.exit(1);
});
