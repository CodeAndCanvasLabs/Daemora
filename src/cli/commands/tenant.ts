/**
 * `daemora tenant *` — admin commands for the multi-tenant control
 * plane. All subcommands read/write `data/tenants.db` directly so they
 * work even when no control-plane HTTP server is running.
 *
 * Examples:
 *   daemora tenant list
 *   daemora tenant create alice@daemora.com
 *   daemora tenant plan alice pro
 *   daemora tenant set alice maxDailyCost 2.00
 *   daemora tenant apikey set alice OPENAI_API_KEY sk-test-123
 *   daemora tenant show alice
 *   daemora tenant start alice
 *   daemora tenant suspend alice "trial expired"
 */

import postgres from "postgres";

import { readBootEnv } from "../../config/env.js";
import { MasterKeyVault } from "../../multitenant/MasterKeyVault.js";
import { TenantManager } from "../../multitenant/TenantManager.js";
import { CreateTenantInput, Plan } from "../../multitenant/types.js";

function help(): void {
  console.log(`daemora tenant — multi-tenant admin

  list                                  show every tenant + status
  create <email> [--slug=<slug>] [--plan=<plan>]
  show <slug>                           full config + recent events
  plan <slug> <lite|pro|trial>          switch plan
  set <slug> <key> <value>              set a config key (JSON parse attempted)
  apikey set <slug> <KEY_NAME> <VALUE>  store an encrypted API key
  apikey list <slug>                    names only (never values)
  apikey delete <slug> <KEY_NAME>
  start <slug>                          spawn the tenant daemora subprocess
  stop <slug>                           SIGTERM the tenant daemora subprocess
  suspend <slug> [reason]               stop + mark suspended
  resume <slug>                         clear suspended status (does not start)
  archive <slug>                        stop + mark archived
  status <slug>                         one-line status
  delete <slug> --yes                   hard delete from registry

Output: human-readable by default. Pipe through jq with --json on
read commands for scripts.`);
}

interface ParsedFlags {
  json: boolean;
  yes: boolean;
  flags: Record<string, string>;
  positional: string[];
}

function parseFlags(args: string[]): ParsedFlags {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  let json = false;
  let yes = false;
  for (const arg of args) {
    if (arg === "--json") { json = true; continue; }
    if (arg === "--yes") { yes = true; continue; }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 2) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        flags[arg.slice(2)] = "true";
      }
      continue;
    }
    positional.push(arg);
  }
  return { json, yes, flags, positional };
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printTenantTable(tenants: Array<{ slug: string; email: string; plan: string; status: string; port: number; createdAt: string }>): void {
  if (tenants.length === 0) {
    console.log("(no tenants)");
    return;
  }
  const widths = {
    slug: Math.max(4, ...tenants.map((t) => t.slug.length)),
    email: Math.max(5, ...tenants.map((t) => t.email.length)),
    plan: 6,
    status: 13,
    port: 5,
    created: 19,
  };
  const pad = (s: string, w: number): string => s.padEnd(w);
  console.log(
    `${pad("SLUG", widths.slug)}  ${pad("EMAIL", widths.email)}  ${pad("PLAN", widths.plan)}  ${pad("STATUS", widths.status)}  ${pad("PORT", widths.port)}  ${pad("CREATED", widths.created)}`,
  );
  for (const t of tenants) {
    console.log(
      `${pad(t.slug, widths.slug)}  ${pad(t.email, widths.email)}  ${pad(t.plan, widths.plan)}  ${pad(t.status, widths.status)}  ${pad(String(t.port), widths.port)}  ${pad(t.createdAt.slice(0, 19), widths.created)}`,
    );
  }
}

async function buildManager(): Promise<{ mgr: TenantManager; sql: postgres.Sql }> {
  const env = readBootEnv();
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL is required — the tenant registry lives in Postgres (#25)");
  const sql = postgres(url, { prepare: false, max: 2 });
  const masterVault = MasterKeyVault.fromEnvOptional();
  const mgr = new TenantManager({
    dataRoot: env.dataDir,
    sql,
    ...(masterVault ? { masterVault } : {}),
  });
  await mgr.init();
  return { mgr, sql };
}

export async function tenantCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    help();
    return;
  }

  const { mgr, sql } = await buildManager();
  try {
    switch (sub) {
      case "list":      await cmdList(mgr, rest); break;
      case "create":    await cmdCreate(mgr, rest); break;
      case "show":      await cmdShow(mgr, rest); break;
      case "plan":      await cmdPlan(mgr, rest); break;
      case "set":       await cmdSet(mgr, rest); break;
      case "apikey":    await cmdApiKey(mgr, rest); break;
      case "start":     await cmdStart(mgr, rest); break;
      case "stop":      await cmdStop(mgr, rest); break;
      case "suspend":   await cmdSuspend(mgr, rest); break;
      case "resume":    await cmdResume(mgr, rest); break;
      case "archive":   await cmdArchive(mgr, rest); break;
      case "status":    await cmdStatus(mgr, rest); break;
      case "delete":    await cmdDelete(mgr, rest); break;
      default:
        console.error(`Unknown tenant subcommand: ${sub}`);
        help();
        process.exit(2);
    }
  } finally {
    await mgr.close();
    await sql.end({ timeout: 5 });
  }
}

async function cmdList(mgr: TenantManager, args: string[]): Promise<void> {
  const { json, flags } = parseFlags(args);
  const tenants = mgr.list(
    flags["status"] ? { status: flags["status"] as never } : undefined,
  );
  if (json) {
    printJson(tenants);
    return;
  }
  printTenantTable(tenants);
}

async function cmdCreate(mgr: TenantManager, args: string[]): Promise<void> {
  const { positional, flags, json } = parseFlags(args);
  const email = positional[0];
  if (!email) {
    console.error("usage: daemora tenant create <email> [--slug=<slug>] [--plan=<plan>]");
    process.exit(2);
  }
  const input = CreateTenantInput.parse({
    email,
    plan: flags["plan"] ?? "trial",
    ...(flags["slug"] ? { slug: flags["slug"] } : {}),
  });
  const tenant = await mgr.create(input);
  if (json) {
    printJson(tenant);
    return;
  }
  console.log(`created tenant ${tenant.slug} (${tenant.email})`);
  console.log(`  plan:    ${tenant.plan}`);
  console.log(`  port:    ${tenant.port}`);
  console.log(`  dataDir: ${tenant.dataDir}`);
}

async function cmdShow(mgr: TenantManager, args: string[]): Promise<void> {
  const { positional, json } = parseFlags(args);
  const slug = positional[0];
  if (!slug) { console.error("usage: daemora tenant show <slug>"); process.exit(2); }
  const detail = mgr.show(slug);
  if (json) { printJson(detail); return; }

  const t = detail.tenant;
  console.log(`tenant: ${t.slug}`);
  console.log(`  email:    ${t.email}`);
  console.log(`  plan:     ${t.plan}`);
  console.log(`  status:   ${t.status}`);
  console.log(`  port:     ${t.port}`);
  console.log(`  dataDir:  ${t.dataDir}`);
  console.log(`  created:  ${t.createdAt}`);
  if (t.suspendedAt) console.log(`  suspended:${t.suspendedAt}  reason: ${t.suspendReason ?? "-"}`);
  if (detail.runtime) console.log(`  runtime:  id=${detail.runtime.id} uptime=${Math.round(detail.runtime.uptimeMs / 1000)}s`);

  if (Object.keys(detail.config).length > 0) {
    console.log("\n  config:");
    for (const [k, v] of Object.entries(detail.config)) {
      console.log(`    ${k}: ${JSON.stringify(v)}`);
    }
  }

  if (detail.apiKeyNames.length > 0) {
    console.log("\n  apiKeys (names only):");
    for (const name of detail.apiKeyNames) console.log(`    ${name}`);
  }

  if (detail.recentEvents.length > 0) {
    console.log("\n  recent events:");
    for (const e of detail.recentEvents) {
      console.log(`    ${e.at}  ${e.kind}  ${e.detail ?? ""}`);
    }
  }
}

async function cmdPlan(mgr: TenantManager, args: string[]): Promise<void> {
  const [slug, plan] = args;
  if (!slug || !plan) {
    console.error("usage: daemora tenant plan <slug> <lite|pro|trial>");
    process.exit(2);
  }
  const parsed = Plan.parse(plan);
  mgr.setPlan(slug, parsed);
  console.log(`tenant ${slug} plan = ${parsed}`);
}

async function cmdSet(mgr: TenantManager, args: string[]): Promise<void> {
  const [slug, key, ...rest] = args;
  if (!slug || !key || rest.length === 0) {
    console.error("usage: daemora tenant set <slug> <key> <value>");
    process.exit(2);
  }
  const raw = rest.join(" ");
  let value: unknown = raw;
  // Try to parse as JSON for typed values; fall back to raw string.
  try { value = JSON.parse(raw); } catch { /* leave as string */ }
  mgr.setConfig(slug, key, value);
  console.log(`tenant ${slug} config: ${key} = ${JSON.stringify(value)}`);
}

async function cmdApiKey(mgr: TenantManager, args: string[]): Promise<void> {
  const [op, slug, name, value] = args;
  if (op === "set") {
    if (!slug || !name || !value) {
      console.error("usage: daemora tenant apikey set <slug> <KEY_NAME> <VALUE>");
      process.exit(2);
    }
    mgr.setApiKey(slug, name, value);
    console.log(`tenant ${slug} apiKey ${name} stored (encrypted)`);
    return;
  }
  if (op === "list") {
    if (!slug) { console.error("usage: daemora tenant apikey list <slug>"); process.exit(2); }
    const names = mgr.listApiKeyNames(slug);
    for (const n of names) console.log(n);
    return;
  }
  if (op === "delete") {
    if (!slug || !name) { console.error("usage: daemora tenant apikey delete <slug> <KEY_NAME>"); process.exit(2); }
    mgr.deleteApiKey(slug, name);
    console.log(`tenant ${slug} apiKey ${name} deleted`);
    return;
  }
  console.error("usage: daemora tenant apikey <set|list|delete> ...");
  process.exit(2);
}

async function cmdStart(mgr: TenantManager, args: string[]): Promise<void> {
  const slug = args[0];
  if (!slug) { console.error("usage: daemora tenant start <slug>"); process.exit(2); }
  const { id, port } = await mgr.start(slug);
  console.log(`tenant ${slug} started: id=${id} port=${port}`);
}

async function cmdStop(mgr: TenantManager, args: string[]): Promise<void> {
  const slug = args[0];
  if (!slug) { console.error("usage: daemora tenant stop <slug>"); process.exit(2); }
  await mgr.stop(slug);
  console.log(`tenant ${slug} stopped`);
}

async function cmdSuspend(mgr: TenantManager, args: string[]): Promise<void> {
  const [slug, ...reasonParts] = args;
  if (!slug) { console.error("usage: daemora tenant suspend <slug> [reason]"); process.exit(2); }
  const reason = reasonParts.join(" ") || "(no reason)";
  await mgr.suspend(slug, reason);
  console.log(`tenant ${slug} suspended: ${reason}`);
}

async function cmdResume(mgr: TenantManager, args: string[]): Promise<void> {
  const slug = args[0];
  if (!slug) { console.error("usage: daemora tenant resume <slug>"); process.exit(2); }
  await mgr.resume(slug);
  console.log(`tenant ${slug} resumed (sleeping)`);
}

async function cmdArchive(mgr: TenantManager, args: string[]): Promise<void> {
  const slug = args[0];
  if (!slug) { console.error("usage: daemora tenant archive <slug>"); process.exit(2); }
  await mgr.archive(slug);
  console.log(`tenant ${slug} archived`);
}

async function cmdStatus(mgr: TenantManager, args: string[]): Promise<void> {
  const slug = args[0];
  if (!slug) { console.error("usage: daemora tenant status <slug>"); process.exit(2); }
  const t = mgr.get(slug);
  if (!t) { console.error(`unknown tenant: ${slug}`); process.exit(1); }
  const running = mgr.listRunning().find((r) => r.slug === slug);
  console.log(running ? `${t.status} (id=${running.id}, port=${running.port})` : t.status);
}

async function cmdDelete(mgr: TenantManager, args: string[]): Promise<void> {
  const { positional, yes } = parseFlags(args);
  const slug = positional[0];
  if (!slug) { console.error("usage: daemora tenant delete <slug> --yes"); process.exit(2); }
  if (!yes) { console.error("refusing to delete without --yes"); process.exit(2); }
  await mgr.stop(slug).catch(() => {});
  mgr.hardDelete(slug);
  console.log(`tenant ${slug} hard-deleted from registry (data dir left on disk)`);
}
