/**
 * IntegrationStore — persists connected accounts for OAuth-backed
 * integrations. Metadata (account id, label, scopes, expiry) lives in
 * a SQLite table so the UI can list connections without unlocking the
 * vault. Tokens live in the vault under keys shaped like
 * `integration:<integration>:<accountId>`, encrypted by the existing
 * AES-GCM + scrypt pipeline.
 *
 * Methods:
 *   upsert({integration, provider, accountId, accountLabel, tokens})
 *   getTokens(integration, accountId?)   → TokenSet | null
 *   list(integration?)                   → IntegrationAccount[]
 *   remove(integration, accountId)       → void  (wipes vault + row)
 *
 * No refresh logic here — IntegrationManager handles that.
 */

import type Database from "better-sqlite3";

import type { ConfigManager } from "../config/ConfigManager.js";
import { createLogger } from "../util/logger.js";
import type { IntegrationAccount, IntegrationId, ProviderId, TokenSet } from "./types.js";

const log = createLogger("integrations.store");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS integration_accounts (
  integration    TEXT NOT NULL,
  provider       TEXT NOT NULL,
  account_id     TEXT NOT NULL,
  account_label  TEXT NOT NULL,
  scopes_json    TEXT NOT NULL,
  connected_at   INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  PRIMARY KEY (integration, account_id)
);
CREATE INDEX IF NOT EXISTS integration_accounts_by_integration
  ON integration_accounts (integration);
`;

function vaultKey(integration: IntegrationId, accountId: string): string {
  return `integration:${integration}:${accountId}`;
}

export class IntegrationStore {
  private readonly insertStmt: Database.Statement;
  private readonly selectOne: Database.Statement;
  private readonly selectByInt: Database.Statement;
  private readonly selectAll: Database.Statement;
  private readonly deleteOne: Database.Statement;

  constructor(
    private readonly db: Database.Database,
    private readonly cfg: ConfigManager,
  ) {
    db.exec(SCHEMA);
    this.insertStmt = db.prepare(
      `INSERT INTO integration_accounts
        (integration, provider, account_id, account_label, scopes_json, connected_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (integration, account_id) DO UPDATE SET
         provider = excluded.provider,
         account_label = excluded.account_label,
         scopes_json = excluded.scopes_json,
         expires_at = excluded.expires_at`,
    );
    this.selectOne = db.prepare(
      `SELECT integration, provider, account_id AS accountId, account_label AS accountLabel,
              scopes_json AS scopesJson, connected_at AS connectedAt, expires_at AS expiresAt
       FROM integration_accounts WHERE integration = ? AND account_id = ?`,
    );
    this.selectByInt = db.prepare(
      `SELECT integration, provider, account_id AS accountId, account_label AS accountLabel,
              scopes_json AS scopesJson, connected_at AS connectedAt, expires_at AS expiresAt
       FROM integration_accounts WHERE integration = ? ORDER BY connected_at DESC`,
    );
    this.selectAll = db.prepare(
      `SELECT integration, provider, account_id AS accountId, account_label AS accountLabel,
              scopes_json AS scopesJson, connected_at AS connectedAt, expires_at AS expiresAt
       FROM integration_accounts ORDER BY connected_at DESC`,
    );
    this.deleteOne = db.prepare(
      `DELETE FROM integration_accounts WHERE integration = ? AND account_id = ?`,
    );
  }

  upsert(args: {
    integration: IntegrationId;
    provider: ProviderId;
    tokens: TokenSet;
  }): void {
    if (!this.cfg.vault.isUnlocked()) {
      throw new Error("Vault is locked — cannot persist integration tokens.");
    }
    const { integration, provider, tokens } = args;
    const key = vaultKey(integration, tokens.accountId);
    this.cfg.vault.set(key, JSON.stringify({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? null,
      expiresAt: tokens.expiresAt,
      scopes: tokens.scopes,
    }));
    this.insertStmt.run(
      integration,
      provider,
      tokens.accountId,
      tokens.accountLabel,
      JSON.stringify(tokens.scopes),
      Date.now(),
      tokens.expiresAt,
    );
    log.info({ integration, accountId: tokens.accountId }, "integration account saved");
  }

  /**
   * Read-back the full token set for a given integration. When no
   * accountId is given the most-recently-connected account wins.
   */
  getTokens(integration: IntegrationId, accountId?: string): TokenSet | null {
    if (!this.cfg.vault.isUnlocked()) return null;
    const row = accountId
      ? this.selectOne.get(integration, accountId) as IntRow | undefined
      : (this.selectByInt.all(integration) as IntRow[])[0];
    if (!row) return null;
    const raw = this.cfg.vault.get(vaultKey(integration, row.accountId))?.reveal();
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as {
        accessToken: string;
        refreshToken: string | null;
        expiresAt: number;
        scopes: string[];
      };
      return {
        accessToken: parsed.accessToken,
        ...(parsed.refreshToken ? { refreshToken: parsed.refreshToken } : {}),
        expiresAt: parsed.expiresAt,
        scopes: parsed.scopes,
        accountId: row.accountId,
        accountLabel: row.accountLabel,
      };
    } catch (e) {
      log.error({ err: (e as Error).message }, "failed to parse vault entry");
      return null;
    }
  }

  list(integration?: IntegrationId): readonly IntegrationAccount[] {
    const rows = integration
      ? this.selectByInt.all(integration) as IntRow[]
      : this.selectAll.all() as IntRow[];
    return rows.map((r) => ({
      integration: r.integration,
      provider: r.provider,
      accountId: r.accountId,
      accountLabel: r.accountLabel,
      scopes: safeJsonArray(r.scopesJson),
      connectedAt: r.connectedAt,
      expiresAt: r.expiresAt,
    }));
  }

  remove(integration: IntegrationId, accountId: string): void {
    const key = vaultKey(integration, accountId);
    try { this.cfg.vault.delete(key); } catch { /* non-fatal */ }
    this.deleteOne.run(integration, accountId);
    log.info({ integration, accountId }, "integration account removed");
  }
}

interface IntRow {
  integration: IntegrationId;
  provider: ProviderId;
  accountId: string;
  accountLabel: string;
  scopesJson: string;
  connectedAt: number;
  expiresAt: number;
}

function safeJsonArray(raw: string): readonly string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}
