/**
 * `daemora daemon <action>` — install/manage the background service.
 *
 *   install [--passphrase <value>]   register with the OS and start it
 *   uninstall                        remove OS registration, stop it
 *   start   [--passphrase <value>]   start the installed service
 *   stop                             stop the running service
 *   restart [--passphrase <value>]   stop + start
 *   status                           print running state + log paths
 *
 * Passphrase is optional. If omitted and the vault is locked, the daemon
 * starts locked — the user can unlock later via the UI. When provided,
 * it is embedded in the OS service definition so the daemon unlocks
 * automatically on boot.
 */

import { DaemonManager } from "../../daemon/DaemonManager.js";

type Action = "install" | "uninstall" | "start" | "stop" | "restart" | "status";

function parseFlags(argv: readonly string[]): { passphrase?: string } {
  const out: { passphrase?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === "--passphrase" || a === "-p") && i + 1 < argv.length) {
      const next = argv[i + 1];
      if (next !== undefined) out.passphrase = next;
      i++;
    } else if (a && a.startsWith("--passphrase=")) {
      out.passphrase = a.slice("--passphrase=".length);
    }
  }
  return out;
}

export async function daemonCommand(argv: readonly string[]): Promise<void> {
  const action = (argv[0] ?? "status") as Action;
  const flags = parseFlags(argv.slice(1));
  const dm = new DaemonManager();

  switch (action) {
    case "install": {
      const result = dm.install(flags.passphrase);
      console.log(`Installed: ${result.servicePath}`);
      console.log("Service will auto-start on login.");
      console.log(`Logs: ${dm.logsDir}/daemon-*.log`);
      return;
    }
    case "uninstall": {
      dm.uninstall();
      console.log("Uninstalled.");
      return;
    }
    case "start": {
      dm.start(flags.passphrase);
      console.log("Started.");
      return;
    }
    case "stop": {
      dm.stop();
      console.log("Stopped.");
      return;
    }
    case "restart": {
      dm.restart(flags.passphrase);
      console.log("Restarted.");
      return;
    }
    case "status": {
      const s = dm.status();
      console.log(JSON.stringify({
        platform: s.platform,
        installed: s.installed,
        running: s.running,
        ...(s.pid !== undefined ? { pid: s.pid } : {}),
        logs: `${dm.logsDir}/daemon-*.log`,
      }, null, 2));
      return;
    }
    default:
      console.error(`Unknown daemon action: ${String(action)}`);
      console.error("Actions: install | uninstall | start | stop | restart | status");
      process.exit(2);
  }
}
