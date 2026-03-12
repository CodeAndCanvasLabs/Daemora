/**
 * database - Query databases: SQLite (built-in), PostgreSQL, MySQL.
 * SQLite: uses better-sqlite3 or falls back to built-in node:sqlite (Node 22+).
 * PostgreSQL/MySQL: requires pg / mysql2 package.
 * Security: uses parameterized queries for all user-supplied values.
 */
import { resolveKey } from "./_env.js";

export async function database(_params) {
  const action = _params?.action;
  const paramsJson = _params?.params;
  if (!action) return "Error: action required. Valid: query, execute, schema, list";
  const params = paramsJson
    ? (typeof paramsJson === "string" ? JSON.parse(paramsJson) : paramsJson)
    : {};

  const { type = "sqlite", dbPath, connectionString, query, values = [], table } = params;

  // ── SQLite ──────────────────────────────────────────────────────────────
  if (type === "sqlite") {
    if (!dbPath) return "Error: dbPath is required for SQLite";

    let db;
    try {
      // Try better-sqlite3 first (synchronous, easiest)
      const { default: Database } = await import("better-sqlite3");
      db = new Database(dbPath, { readonly: action === "query" || action === "schema" || action === "list" });
    } catch {
      // Fall back to node:sqlite (Node 22+)
      try {
        const { DatabaseSync } = await import("node:sqlite");
        db = new DatabaseSync(dbPath, { open: true });
      } catch {
        return "Error: SQLite driver not found. Run: npm install better-sqlite3 (or use Node 22+ for built-in sqlite)";
      }
    }

    try {
      if (action === "query" || action === "execute") {
        if (!query) return "Error: query is required";
        // Detect if it's a select (returns rows) or write (returns changes)
        const isSelect = /^\s*select\b/i.test(query);
        if (isSelect || action === "query") {
          const stmt = db.prepare(query);
          const rows = stmt.all(...values);
          if (!rows.length) return "Query returned 0 rows";
          return JSON.stringify(rows, null, 2);
        } else {
          const stmt = db.prepare(query);
          const info = stmt.run(...values);
          return `OK: ${info.changes} row(s) affected, lastInsertRowid=${info.lastInsertRowid}`;
        }
      }

      if (action === "schema") {
        const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name").all();
        if (!tables.length) return "No tables found in database";
        return tables.map(t => `-- ${t.name}\n${t.sql}`).join("\n\n");
      }

      if (action === "list") {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
        return tables.length ? tables.map(t => t.name).join("\n") : "No tables found";
      }
    } catch (err) {
      return `SQLite error: ${err.message}`;
    } finally {
      if (db?.close) db.close();
    }
  }

  // ── PostgreSQL ──────────────────────────────────────────────────────────
  if (type === "postgres" || type === "postgresql") {
    const connStr = connectionString || resolveKey("DATABASE_URL") || resolveKey("POSTGRES_URL");
    if (!connStr) return "Error: connectionString or DATABASE_URL env var required for PostgreSQL";

    let client;
    try {
      const { Client } = await import("pg");
      client = new Client({ connectionString: connStr });
      await client.connect();

      if (action === "query" || action === "execute") {
        if (!query) return "Error: query is required";
        const result = await client.query(query, values);
        if (result.rows.length === 0) return `OK: ${result.rowCount} row(s) affected`;
        return JSON.stringify(result.rows, null, 2);
      }

      if (action === "schema") {
        const tbl = table || "%";
        const result = await client.query(
          "SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name LIKE $1 ORDER BY table_name, ordinal_position",
          [tbl]
        );
        if (!result.rows.length) return "No columns found";
        const grouped = {};
        for (const row of result.rows) {
          if (!grouped[row.table_name]) grouped[row.table_name] = [];
          grouped[row.table_name].push(`  ${row.column_name} ${row.data_type}${row.is_nullable === "NO" ? " NOT NULL" : ""}`);
        }
        return Object.entries(grouped).map(([t, cols]) => `-- ${t}\n${cols.join("\n")}`).join("\n\n");
      }

      if (action === "list") {
        const result = await client.query(
          "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name"
        );
        return result.rows.map(r => r.table_name).join("\n") || "No tables found";
      }
    } catch (err) {
      return `PostgreSQL error: ${err.message}`;
    } finally {
      if (client) await client.end().catch(() => {});
    }
  }

  // ── MySQL ───────────────────────────────────────────────────────────────
  if (type === "mysql") {
    const connStr = connectionString || resolveKey("MYSQL_URL");
    if (!connStr) return "Error: connectionString or MYSQL_URL env var required for MySQL";

    let conn;
    try {
      const mysql = await import("mysql2/promise");
      conn = await mysql.createConnection(connStr);

      if (action === "query" || action === "execute") {
        if (!query) return "Error: query is required";
        const [rows] = await conn.execute(query, values);
        if (!Array.isArray(rows)) return `OK: ${rows.affectedRows} row(s) affected`;
        if (!rows.length) return "Query returned 0 rows";
        return JSON.stringify(rows, null, 2);
      }

      if (action === "schema") {
        const [rows] = await conn.execute("SHOW TABLES");
        return rows.map(r => Object.values(r)[0]).join("\n") || "No tables found";
      }

      if (action === "list") {
        const [rows] = await conn.execute("SHOW TABLES");
        return rows.map(r => Object.values(r)[0]).join("\n") || "No tables found";
      }
    } catch (err) {
      return `MySQL error: ${err.message}`;
    } finally {
      if (conn) await conn.end().catch(() => {});
    }
  }

  return `Unknown database type: "${type}". Valid: sqlite, postgres, mysql`;
}

export const databaseDescription =
  `database(action: string, paramsJson?: object) - Query SQLite, PostgreSQL, or MySQL databases.
  action: "query" | "execute" | "schema" | "list"
  params.type: "sqlite" (default) | "postgres" | "mysql"
  sqlite: { dbPath: "/path/to/db.sqlite", query, values? }
  postgres: { connectionString?, query, values? } (or DATABASE_URL env)
  mysql: { connectionString?, query, values? } (or MYSQL_URL env)
  Env vars: DATABASE_URL, POSTGRES_URL, MYSQL_URL
  Note: Uses parameterized queries (values array) to prevent SQL injection.
  Examples:
    database("query", {"dbPath":"./app.db","query":"SELECT * FROM users LIMIT 10"})
    database("execute", {"type":"postgres","query":"INSERT INTO logs(msg) VALUES($1)","values":["hello"]})
    database("schema", {"type":"postgres"})
    database("list", {"dbPath":"./data.db"})`;
