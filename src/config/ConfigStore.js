import { getDb } from "../storage/Database.js";

/**
 * ConfigStore - non-secret configuration stored in SQLite config_entries table.
 *
 * Keys are env-var-style strings (PORT, DEFAULT_MODEL, PERMISSION_TIER, etc.)
 * matching the same keys used in .env - so reloadFromDb() can inject them
 * directly into process.env without key translation.
 *
 * Secrets (API keys, tokens) belong in SecretVault, not here.
 */
class ConfigStore {
  get(key) {
    try {
      const row = getDb().prepare("SELECT value FROM config_entries WHERE key = ?").get(key);
      return row?.value ?? null;
    } catch { return null; }
  }

  set(key, value) {
    getDb().prepare(
      "INSERT OR REPLACE INTO config_entries (key, value, updated_at) VALUES (?, ?, datetime('now'))"
    ).run(key, String(value));
  }

  delete(key) {
    getDb().prepare("DELETE FROM config_entries WHERE key = ?").run(key);
  }

  getAll() {
    try {
      const rows = getDb().prepare("SELECT key, value FROM config_entries").all();
      return Object.fromEntries(rows.map(r => [r.key, r.value]));
    } catch { return {}; }
  }

  /**
   * Bulk import a key-value map into config_entries.
   * @param {Record<string,string>} kvMap
   * @param {{ skipExisting?: boolean }} opts  - skipExisting=true → INSERT OR IGNORE
   * @returns {number} entries written
   */
  import(kvMap, { skipExisting = false } = {}) {
    const db = getDb();
    const upsert = db.prepare(
      "INSERT OR REPLACE INTO config_entries (key, value, updated_at) VALUES (?, ?, datetime('now'))"
    );
    const ignore = db.prepare(
      "INSERT OR IGNORE INTO config_entries (key, value) VALUES (?, ?)"
    );
    let count = 0;
    for (const [key, value] of Object.entries(kvMap)) {
      if (value === undefined || value === null) continue;
      (skipExisting ? ignore : upsert).run(key, String(value));
      count++;
    }
    return count;
  }
}

export const configStore = new ConfigStore();
export default configStore;
