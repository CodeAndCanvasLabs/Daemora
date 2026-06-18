/**
 * Postgres + Drizzle client. One pool per process; reuses the same
 * connection across requests. `close()` only matters for tests.
 */

import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "./schema.js";

let client: postgres.Sql | undefined;
let db: PostgresJsDatabase<typeof schema> | undefined;

export type DB = PostgresJsDatabase<typeof schema>;

export function getDb(databaseUrl: string): { db: DB; client: postgres.Sql } {
  if (db && client) return { db, client };
  client = postgres(databaseUrl, {
    max: 10,                          // connection pool size
    idle_timeout: 30,
    connect_timeout: 10,
    prepare: false,                   // Neon poolers like pgbouncer prefer prepare:false
  });
  db = drizzle(client, { schema });
  return { db, client };
}

export async function closeDb(): Promise<void> {
  if (client) {
    await client.end({ timeout: 5 });
    client = undefined;
    db = undefined;
  }
}

export { schema };
