/**
 * `daemora-ts doctor` — self-diagnose common failure modes.
 *
 * Checks:
 *   - data dir writable
 *   - SQLite db opens + WAL enabled
 *   - vault file exists + readable
 *   - at least one LLM provider has an API key (or ollama is keyless)
 *   - skills root loads at least one skill
 *   - MCP mcp.json parses
 *   - declarative memory files readable if present
 *
 * Prints a green ✓ / red ✗ per check with a short hint. Exits 0 if all
 * pass, 1 if any fail.
 */

import { accessSync, constants, existsSync } from "node:fs";

import { ConfigManager } from "../../config/ConfigManager.js";
import { MCPStore } from "../../mcp/MCPStore.js";
import { DeclarativeMemoryStore } from "../../memory/DeclarativeMemoryStore.js";
import { ModelRouter } from "../../models/ModelRouter.js";
import { providerIds, providerRegistry } from "../../models/registry.js";
import { SkillLoader } from "../../skills/SkillLoader.js";

interface Check { name: string; ok: boolean; detail: string }

export async function doctorCommand(): Promise<void> {
  const results: Check[] = [];
  const cfg = ConfigManager.open();

  // data dir writable
  try {
    accessSync(cfg.env.dataDir, constants.W_OK);
    results.push({ name: "data dir writable", ok: true, detail: cfg.env.dataDir });
  } catch (e) {
    results.push({ name: "data dir writable", ok: false, detail: (e as Error).message });
  }

  // db
  try {
    const journal = cfg.database.pragma("journal_mode", { simple: true }) as string;
    results.push({ name: "SQLite opens + WAL", ok: journal === "wal", detail: `journal=${journal}` });
  } catch (e) {
    results.push({ name: "SQLite opens + WAL", ok: false, detail: (e as Error).message });
  }

  // vault
  const vaultExists = cfg.vault.exists();
  results.push({
    name: "vault file exists",
    ok: vaultExists,
    detail: vaultExists ? "yes" : "no (run `daemora-ts setup`)",
  });

  // providers (any one with a key configured, or ollama reachable)
  const providers: string[] = [];
  const models = new ModelRouter(cfg);
  for (const pid of providerIds) {
    if (models.providerAvailable(pid)) providers.push(pid);
  }
  results.push({
    name: "LLM provider configured",
    ok: providers.length > 0,
    detail: providers.length > 0 ? providers.join(", ") : "no provider key in vault — add one at /settings",
  });

  // default model
  try {
    const def = cfg.setting("DEFAULT_MODEL");
    results.push({ name: "default model set", ok: !!def, detail: def ? String(def) : "unset" });
  } catch {
    results.push({ name: "default model set", ok: false, detail: "error reading setting" });
  }

  // skills
  const skillsDir = process.env["SKILLS_DIR"]
    ?? new URL("../../../skills", import.meta.url).pathname;
  try {
    const loader = new SkillLoader(skillsDir);
    const { loaded, skipped } = await loader.loadAll();
    results.push({
      name: "skills load",
      ok: loaded.length > 0,
      detail: `${loaded.length} loaded, ${skipped.length} skipped`,
    });
  } catch (e) {
    results.push({ name: "skills load", ok: false, detail: (e as Error).message });
  }

  // MCP
  try {
    const store = new MCPStore(cfg.env.dataDir);
    const servers = store.list();
    results.push({
      name: "mcp.json parses",
      ok: true,
      detail: `${servers.length} servers registered`,
    });
  } catch (e) {
    results.push({ name: "mcp.json parses", ok: false, detail: (e as Error).message });
  }

  // declarative memory
  const memDir = process.env["MEMORY_DIR"] ?? `${cfg.env.dataDir}/memory`;
  if (existsSync(memDir)) {
    try {
      const dm = new DeclarativeMemoryStore(memDir);
      await dm.load();
      results.push({
        name: "declarative memory",
        ok: true,
        detail: `user=${dm.listEntries("user").length}, memory=${dm.listEntries("memory").length}`,
      });
    } catch (e) {
      results.push({ name: "declarative memory", ok: false, detail: (e as Error).message });
    }
  } else {
    results.push({ name: "declarative memory", ok: true, detail: "not created yet (first run)" });
  }

  // Print
  let failed = 0;
  console.log("\nDaemora-TS doctor\n");
  for (const r of results) {
    const mark = r.ok ? "\u001b[32m✓\u001b[0m" : "\u001b[31m✗\u001b[0m";
    console.log(`  ${mark} ${r.name.padEnd(28)}  ${r.detail}`);
    if (!r.ok) failed++;
  }
  console.log();
  if (failed === 0) {
    console.log("All checks passed.");
  } else {
    console.log(`${failed} check(s) failed. Resolve above before starting.`);
  }

  cfg.close();
  process.exit(failed === 0 ? 0 : 1);

  // Reference providerRegistry so the tree-shaker doesn't drop the import —
  // used transitively by ModelRouter above for stricter typechecking.
  void providerRegistry;
}
