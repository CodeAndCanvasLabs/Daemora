import { join } from "path";
import { mkdirSync, existsSync, readFileSync, readdirSync, renameSync, statSync } from "fs";
import { createRequire } from "module";
import { config } from "../config/default.js";

const require = createRequire(import.meta.url);

let _db = null;

// ── Singleton ────────────────────────────────────────────────────────────────

export function getDb() {
  if (_db) return _db;
  const { DatabaseSync } = require("node:sqlite");
  mkdirSync(config.dataDir, { recursive: true });
  _db = new DatabaseSync(join(config.dataDir, "daemora.db"));
  _db.exec("PRAGMA journal_mode = WAL");
  _db.exec("PRAGMA busy_timeout = 5000");
  _db.exec("PRAGMA foreign_keys = ON");
  _initTables(_db);
  _runMigrations(_db);
  _migrateFromFlatFiles();
  return _db;
}

// ── Reusable Helpers ─────────────────────────────────────────────────────────

export function queryAll(sql, params = {}) {
  return getDb().prepare(sql).all(params);
}

export function queryOne(sql, params = {}) {
  return getDb().prepare(sql).get(params);
}

export function run(sql, params = {}) {
  return getDb().prepare(sql).run(params);
}

export function transaction(fn) {
  const db = getDb();
  db.exec("BEGIN");
  try {
    const result = fn(db);
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// ── Table Definitions ────────────────────────────────────────────────────────

function _initTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      tenant_id TEXT,
      channel TEXT,
      session_id TEXT,
      type TEXT NOT NULL DEFAULT 'chat',
      title TEXT,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      priority TEXT DEFAULT 'normal',
      parent_task_id TEXT,
      agent_id TEXT,
      agent_created INTEGER DEFAULT 0,
      input TEXT,
      result TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_tenant ON tasks(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);

    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      config TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT,
      suspended INTEGER DEFAULT 0,
      suspend_reason TEXT
    );

    CREATE TABLE IF NOT EXISTS tenant_channels (
      channel  TEXT NOT NULL,
      user_id  TEXT NOT NULL,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      linked_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (channel, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_tenant_channels_tenant ON tenant_channels(tenant_id);

    CREATE TABLE IF NOT EXISTS vault_entries (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS config_entries (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS cost_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT,
      task_id TEXT,
      model_id TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      estimated_cost REAL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_costs_tenant_date ON cost_entries(tenant_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_costs_date ON cost_entries(created_at);

    CREATE TABLE IF NOT EXISTS memory_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT,
      content TEXT NOT NULL,
      category TEXT DEFAULT 'general',
      timestamp TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_memory_tenant ON memory_entries(tenant_id);

    CREATE TABLE IF NOT EXISTS embeddings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT,
      content TEXT NOT NULL,
      embedding TEXT NOT NULL,
      source TEXT DEFAULT 'memory',
      category TEXT DEFAULT 'general',
      provider TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_embeddings_tenant ON embeddings(tenant_id);

    CREATE TABLE IF NOT EXISTS daily_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT,
      date TEXT NOT NULL,
      entry TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_daily_logs_tenant_date ON daily_logs(tenant_id, date);

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT,
      event TEXT NOT NULL,
      data TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_audit_tenant_date ON audit_log(tenant_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_event ON audit_log(event);

    CREATE TABLE IF NOT EXISTS cron_jobs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT,
      name TEXT NOT NULL,
      description TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      delete_after_run INTEGER NOT NULL DEFAULT 0,
      schedule_kind TEXT NOT NULL DEFAULT 'cron',
      cron_expr TEXT,
      cron_tz TEXT,
      every_ms INTEGER,
      at_time TEXT,
      stagger_ms INTEGER DEFAULT 0,
      task_input TEXT NOT NULL,
      model TEXT,
      thinking TEXT,
      timeout_seconds INTEGER DEFAULT 7200,
      delivery_mode TEXT DEFAULT 'none',
      delivery_channel TEXT,
      delivery_to TEXT,
      delivery_channel_meta TEXT,
      max_retries INTEGER DEFAULT 0,
      retry_backoff_ms INTEGER DEFAULT 30000,
      failure_alert TEXT,
      next_run_at TEXT,
      last_run_at TEXT,
      last_status TEXT,
      last_error TEXT,
      last_duration_ms INTEGER,
      consecutive_errors INTEGER DEFAULT 0,
      run_count INTEGER DEFAULT 0,
      running_since TEXT,
      last_failure_alert_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_cron_jobs_tenant ON cron_jobs(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_cron_jobs_next_run ON cron_jobs(next_run_at);
    CREATE INDEX IF NOT EXISTS idx_cron_jobs_enabled ON cron_jobs(enabled);

    CREATE TABLE IF NOT EXISTS cron_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      tenant_id TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT,
      duration_ms INTEGER,
      error TEXT,
      result_preview TEXT,
      task_id TEXT,
      delivery_status TEXT DEFAULT 'not-requested',
      delivery_error TEXT,
      retry_attempt INTEGER DEFAULT 0,
      cost TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cron_runs_job ON cron_runs(job_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_cron_runs_tenant ON cron_runs(tenant_id, started_at);
  `);
}

// ── Schema Migrations ────────────────────────────────────────────────────────
// ALTER TABLE for columns added after initial schema creation.
// Each migration is idempotent — silently skipped if column already exists.

function _runMigrations(db) {
  // Add column only when missing. exec() throws on failure in node:sqlite.
  const _cols = () => db.prepare("PRAGMA table_info(tasks)").all().map(r => r.name);
  const _addCol = (col, type) => {
    if (_cols().includes(col)) return;
    db.exec(`ALTER TABLE tasks ADD COLUMN ${col} ${type}`);
    // Verify it actually worked
    if (!_cols().includes(col)) {
      console.error(`[Database] Migration FAILED: could not add tasks.${col}`);
    } else {
      console.log(`[Database] Migration: added tasks.${col}`);
    }
  };
  _addCol("channel", "TEXT");
  _addCol("session_id", "TEXT");
  _addCol("tool_calls", "TEXT");
  _addCol("sub_agents", "TEXT");
  _addCol("cost", "TEXT");

  // Backfill tenant_channels from existing "channel:userId" tenant IDs (idempotent)
  const tenants = db.prepare("SELECT id FROM tenants").all();
  for (const { id } of tenants) {
    const colonIdx = id.indexOf(":");
    if (colonIdx === -1) continue;
    const channel = id.slice(0, colonIdx);
    const userId  = id.slice(colonIdx + 1);
    if (!channel || !userId) continue;
    db.prepare(
      "INSERT OR IGNORE INTO tenant_channels (channel, user_id, tenant_id) VALUES (?, ?, ?)"
    ).run(channel, userId, id);
  }
}

// ── Flat File Migration ──────────────────────────────────────────────────────
// On first run, import existing flat file data into SQLite, then rename to .bak.

let _migrated = false;

function _migrateFromFlatFiles() {
  if (_migrated) return;
  _migrated = true;

  _migrateSessions();
  _migrateTasks();
  _migrateTenants();
  _migrateCosts();
  _migrateAudit();
  _migrateMemory();
}

function _safeBak(filePath) {
  if (existsSync(filePath)) {
    try { renameSync(filePath, filePath + ".bak"); } catch {}
  }
}

function _migrateSessions() {
  const dir = config.sessionsDir;
  if (!existsSync(dir)) return;
  const files = readdirSync(dir).filter(f => f.endsWith(".json"));
  if (files.length === 0) return;

  // Skip if sessions already exist in DB
  const existing = queryOne("SELECT COUNT(*) as cnt FROM sessions");
  if (existing.cnt > 0) return;

  console.log(`[Database] Migrating ${files.length} session files to SQLite...`);
  transaction(() => {
    for (const f of files) {
      try {
        const data = JSON.parse(readFileSync(join(dir, f), "utf-8"));
        const sessionId = data.sessionId || f.replace(".json", "");
        run(
          "INSERT OR IGNORE INTO sessions (id, created_at) VALUES ($id, $created_at)",
          { $id: sessionId, $created_at: data.createdAt || new Date().toISOString() }
        );
        if (Array.isArray(data.messages)) {
          for (const msg of data.messages) {
            run(
              "INSERT INTO messages (session_id, role, content, created_at) VALUES ($sid, $role, $content, $ts)",
              {
                $sid: sessionId,
                $role: msg.role || "user",
                $content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
                $ts: msg.timestamp || new Date().toISOString(),
              }
            );
          }
        }
        _safeBak(join(dir, f));
      } catch (err) {
        console.log(`[Database] Session migration error (${f}): ${err.message}`);
      }
    }
  });
  console.log(`[Database] Sessions migrated.`);
}

function _migrateTasks() {
  const dir = config.tasksDir;
  if (!existsSync(dir)) return;
  const files = readdirSync(dir).filter(f => f.endsWith(".json"));
  if (files.length === 0) return;

  const existing = queryOne("SELECT COUNT(*) as cnt FROM tasks");
  if (existing.cnt > 0) return;

  console.log(`[Database] Migrating ${files.length} task files to SQLite...`);
  transaction(() => {
    for (const f of files) {
      try {
        const t = JSON.parse(readFileSync(join(dir, f), "utf-8"));
        run(
          `INSERT OR IGNORE INTO tasks (id, tenant_id, type, title, description, status, priority,
           parent_task_id, agent_id, agent_created, input, result, error,
           created_at, started_at, completed_at, updated_at)
           VALUES ($id, $tenant_id, $type, $title, $desc, $status, $priority,
           $parent, $agent_id, $agent_created, $input, $result, $error,
           $created_at, $started_at, $completed_at, $updated_at)`,
          {
            $id: t.id,
            $tenant_id: t.tenantId || null,
            $type: t.type || "chat",
            $title: t.title || null,
            $desc: t.description || null,
            $status: t.status || "pending",
            $priority: t.priority || "normal",
            $parent: t.parentTaskId || null,
            $agent_id: t.agentId || null,
            $agent_created: t.agentCreated ? 1 : 0,
            $input: t.input ? (typeof t.input === "string" ? t.input : JSON.stringify(t.input)) : null,
            $result: t.result ? (typeof t.result === "string" ? t.result : JSON.stringify(t.result)) : null,
            $error: t.error || null,
            $created_at: t.createdAt || new Date().toISOString(),
            $started_at: t.startedAt || null,
            $completed_at: t.completedAt || null,
            $updated_at: t.updatedAt || t.createdAt || new Date().toISOString(),
          }
        );
        _safeBak(join(dir, f));
      } catch (err) {
        console.log(`[Database] Task migration error (${f}): ${err.message}`);
      }
    }
  });
  console.log(`[Database] Tasks migrated.`);
}

function _migrateTenants() {
  const tenantsPath = join(config.dataDir, "tenants", "tenants.json");
  if (!existsSync(tenantsPath)) return;

  const existing = queryOne("SELECT COUNT(*) as cnt FROM tenants");
  if (existing.cnt > 0) return;

  console.log(`[Database] Migrating tenants.json to SQLite...`);
  try {
    const tenants = JSON.parse(readFileSync(tenantsPath, "utf-8"));
    transaction(() => {
      for (const [id, t] of Object.entries(tenants)) {
        run(
          `INSERT OR IGNORE INTO tenants (id, config, created_at, last_seen_at, suspended, suspend_reason)
           VALUES ($id, $config, $created_at, $last_seen_at, $suspended, $suspend_reason)`,
          {
            $id: id,
            $config: JSON.stringify(t),
            $created_at: t.createdAt || new Date().toISOString(),
            $last_seen_at: t.lastSeenAt || null,
            $suspended: t.suspended ? 1 : 0,
            $suspend_reason: t.suspendReason || null,
          }
        );
      }
    });
    _safeBak(tenantsPath);
    console.log(`[Database] Tenants migrated.`);
  } catch (err) {
    console.log(`[Database] Tenant migration error: ${err.message}`);
  }
}

function _migrateCosts() {
  const dir = config.costsDir;
  if (!existsSync(dir)) return;
  const files = readdirSync(dir).filter(f => f.endsWith(".jsonl"));
  if (files.length === 0) return;

  const existing = queryOne("SELECT COUNT(*) as cnt FROM cost_entries");
  if (existing.cnt > 0) return;

  console.log(`[Database] Migrating ${files.length} cost log files to SQLite...`);
  transaction(() => {
    for (const f of files) {
      try {
        const lines = readFileSync(join(dir, f), "utf-8").trim().split("\n").filter(Boolean);
        for (const line of lines) {
          try {
            const e = JSON.parse(line);
            run(
              `INSERT INTO cost_entries (tenant_id, task_id, model_id, input_tokens, output_tokens, estimated_cost, created_at)
               VALUES ($tenant_id, $task_id, $model_id, $input, $output, $cost, $created_at)`,
              {
                $tenant_id: e.tenantId || null,
                $task_id: e.taskId || null,
                $model_id: e.modelId || null,
                $input: e.inputTokens || 0,
                $output: e.outputTokens || 0,
                $cost: e.estimatedCost || 0,
                $created_at: e.timestamp || new Date().toISOString(),
              }
            );
          } catch {}
        }
        _safeBak(join(dir, f));
      } catch (err) {
        console.log(`[Database] Cost migration error (${f}): ${err.message}`);
      }
    }
  });
  console.log(`[Database] Costs migrated.`);
}

function _migrateAudit() {
  const dir = config.auditDir;
  if (!existsSync(dir)) return;
  const files = readdirSync(dir).filter(f => f.endsWith(".jsonl"));
  if (files.length === 0) return;

  const existing = queryOne("SELECT COUNT(*) as cnt FROM audit_log");
  if (existing.cnt > 0) return;

  console.log(`[Database] Migrating ${files.length} audit log files to SQLite...`);
  transaction(() => {
    for (const f of files) {
      try {
        const lines = readFileSync(join(dir, f), "utf-8").trim().split("\n").filter(Boolean);
        for (const line of lines) {
          try {
            const e = JSON.parse(line);
            const { timestamp, tenantId, event, ...rest } = e;
            run(
              `INSERT INTO audit_log (tenant_id, event, data, created_at)
               VALUES ($tenant_id, $event, $data, $created_at)`,
              {
                $tenant_id: tenantId || null,
                $event: event || "unknown",
                $data: Object.keys(rest).length > 0 ? JSON.stringify(rest) : null,
                $created_at: timestamp || new Date().toISOString(),
              }
            );
          } catch {}
        }
        _safeBak(join(dir, f));
      } catch (err) {
        console.log(`[Database] Audit migration error (${f}): ${err.message}`);
      }
    }
  });
  console.log(`[Database] Audit logs migrated.`);
}

function _migrateMemory() {
  _migrateMemoryDir(null, config.memoryPath, config.memoryDir);

  // Migrate per-tenant memory
  const tenantsDir = join(config.dataDir, "tenants");
  if (!existsSync(tenantsDir)) return;
  try {
    const tenantDirs = readdirSync(tenantsDir).filter(d => {
      try { return statSync(join(tenantsDir, d)).isDirectory(); } catch { return false; }
    });
    for (const safeId of tenantDirs) {
      const tenantMemoryPath = join(tenantsDir, safeId, "MEMORY.md");
      const tenantMemoryDir = join(tenantsDir, safeId, "memory");
      const tenantId = safeId.replace(/_/g, ":");  // rough reverse of safe encoding
      _migrateMemoryDir(tenantId, tenantMemoryPath, tenantMemoryDir);
    }
  } catch {}
}

const ENTRY_REGEX_MIG = /<!--\s*\[([^\]]+)\](?:\s*\[CATEGORY:([^\]]+)\])?\s*([\s\S]*?)\s*-->/g;

function _migrateMemoryDir(tenantId, memoryPath, memoryDir) {
  // Migrate MEMORY.md entries
  if (existsSync(memoryPath)) {
    const content = readFileSync(memoryPath, "utf-8");
    const entries = [];
    let match;
    ENTRY_REGEX_MIG.lastIndex = 0;
    while ((match = ENTRY_REGEX_MIG.exec(content)) !== null) {
      entries.push({ timestamp: match[1], category: match[2] || "general", text: match[3].trim() });
    }
    if (entries.length > 0) {
      const existingCount = queryOne(
        "SELECT COUNT(*) as cnt FROM memory_entries WHERE tenant_id IS $tid",
        { $tid: tenantId }
      );
      if (existingCount.cnt === 0) {
        console.log(`[Database] Migrating ${entries.length} memory entries${tenantId ? ` (${tenantId})` : ""}...`);
        transaction(() => {
          for (const e of entries) {
            run(
              `INSERT INTO memory_entries (tenant_id, content, category, timestamp)
               VALUES ($tid, $content, $cat, $ts)`,
              { $tid: tenantId, $content: e.text, $cat: e.category, $ts: e.timestamp }
            );
          }
        });
        _safeBak(memoryPath);
      }
    }
  }

  // Migrate embeddings.json
  const embPath = join(memoryDir, "embeddings.json");
  if (existsSync(embPath)) {
    const existingCount = queryOne(
      "SELECT COUNT(*) as cnt FROM embeddings WHERE tenant_id IS $tid",
      { $tid: tenantId }
    );
    if (existingCount.cnt === 0) {
      try {
        const embeds = JSON.parse(readFileSync(embPath, "utf-8"));
        if (embeds.length > 0) {
          console.log(`[Database] Migrating ${embeds.length} embeddings${tenantId ? ` (${tenantId})` : ""}...`);
          transaction(() => {
            for (const e of embeds) {
              run(
                `INSERT INTO embeddings (tenant_id, content, embedding, source, category, provider, created_at)
                 VALUES ($tid, $content, $emb, $src, $cat, $prov, $ts)`,
                {
                  $tid: tenantId,
                  $content: e.text || e.content || "",
                  $emb: JSON.stringify(e.vector || e.embedding || []),
                  $src: "memory",
                  $cat: e.category || "general",
                  $prov: e.provider || null,
                  $ts: e.timestamp || new Date().toISOString(),
                }
              );
            }
          });
          _safeBak(embPath);
        }
      } catch {}
    }
  }

  // Migrate daily logs
  if (existsSync(memoryDir)) {
    const logFiles = readdirSync(memoryDir).filter(f => f.endsWith(".md") && /^\d{4}-\d{2}-\d{2}\.md$/.test(f));
    if (logFiles.length > 0) {
      const existingCount = queryOne(
        "SELECT COUNT(*) as cnt FROM daily_logs WHERE tenant_id IS $tid",
        { $tid: tenantId }
      );
      if (existingCount.cnt === 0) {
        console.log(`[Database] Migrating ${logFiles.length} daily logs${tenantId ? ` (${tenantId})` : ""}...`);
        transaction(() => {
          for (const f of logFiles) {
            const date = f.replace(".md", "");
            const content = readFileSync(join(memoryDir, f), "utf-8");
            // Each line starting with "- " is an entry
            const lines = content.split("\n").filter(l => l.startsWith("- "));
            for (const line of lines) {
              run(
                "INSERT INTO daily_logs (tenant_id, date, entry) VALUES ($tid, $date, $entry)",
                { $tid: tenantId, $date: date, $entry: line.replace(/^- /, "").trim() }
              );
            }
            _safeBak(join(memoryDir, f));
          }
        });
      }
    }
  }
}
