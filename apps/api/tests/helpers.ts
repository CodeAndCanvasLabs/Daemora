/**
 * Test helpers — in-memory Postgres + fresh DB per test.
 * pg-mem speaks the real Postgres wire protocol enough that Drizzle works.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { drizzle } from "drizzle-orm/pg-proxy";
import { DataType, newDb } from "pg-mem";

import * as schema from "../src/db/schema.js";
import type { DB } from "../src/db/client.js";

const MIGRATION_PATH = join(process.cwd(), "apps/api/drizzle/0000_flimsy_shape.sql");

let cachedMigration: string | undefined;
function readMigration(): string {
  if (cachedMigration) return cachedMigration;
  cachedMigration = readFileSync(MIGRATION_PATH, "utf-8");
  return cachedMigration;
}

/** Create a fresh in-memory Postgres + Drizzle client + applied schema. */
export function makeTestDb(): { db: DB; close: () => void } {
  const pg = newDb({ autoCreateForeignKeyIndices: true });
  // pg-mem needs gen_random_uuid() polyfilled.
  pg.public.registerFunction({
    name: "gen_random_uuid",
    returns: DataType.uuid,
    implementation: () => crypto.randomUUID(),
    impure: true,
  });
  pg.public.registerFunction({
    name: "now",
    returns: DataType.timestamptz,
    implementation: () => new Date(),
    impure: true,
  });

  // Apply schema.
  const migration = readMigration();
  // pg-mem doesn't love drizzle's "--> statement-breakpoint" lines —
  // strip them and split by `;` ourselves.
  const cleaned = migration.replace(/--> statement-breakpoint/g, "");
  for (const stmt of cleaned.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) {
    try { pg.public.none(stmt + ";"); } catch (err) {
      // pg-mem can't do every fancy index syntax. Skip soft failures
      // for index DDL only — tables and FKs must succeed.
      if (!stmt.startsWith("CREATE INDEX") && !stmt.startsWith("CREATE UNIQUE INDEX")) {
        throw new Error(`pg-mem migration failed on:\n${stmt}\n\n${(err as Error).message}`);
      }
    }
  }

  // Drizzle-pg-proxy lets us inject a fake query runner that talks to
  // pg-mem instead of opening a TCP socket.
  const db = drizzle(async (query, params, method) => {
    try {
      const result = method === "all"
        ? pg.public.many(rewriteParams(query, params))
        : pg.public.query(rewriteParams(query, params)).rows;
      return { rows: result.map((r: Record<string, unknown>) => Object.values(r)) };
    } catch (err) {
      throw new Error(`pg-mem query failed:\n${query}\nparams: ${JSON.stringify(params)}\n${(err as Error).message}`);
    }
  }, { schema }) as unknown as DB;

  return {
    db,
    close: () => { /* pg-mem cleans up on GC */ },
  };
}

/**
 * pg-mem doesn't bind $1 / $2 placeholders the same way; we substitute
 * literals (already escaped by Drizzle for our usage). Good enough for
 * tests; production goes through real Postgres.
 */
function rewriteParams(query: string, params: unknown[]): string {
  let i = 0;
  return query.replace(/\$(\d+)/g, (_, idx) => {
    const value = params[Number(idx) - 1];
    if (value === null || value === undefined) return "NULL";
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (value instanceof Date) return `'${value.toISOString()}'`;
    if (Array.isArray(value) || typeof value === "object") return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
    void i;
    return `'${String(value).replace(/'/g, "''")}'`;
  });
}
