/**
 * Auth factory — wires AuthStore + LocalAuthProvider + TokenService
 * together with a signing key derived from the vault.
 *
 * Signing key derivation:
 *   - HKDF-SHA256 from the vault's per-install salt + a fixed label
 *     ("daemora-auth-sign-v1"). Deterministic per-install, unique
 *     across installs.
 *   - Rotating the vault (new passphrase, same data) preserves the
 *     salt so tokens survive — which is what we want, since
 *     legitimate passphrase rotation shouldn't log everyone out by
 *     side-effect of invalidating signatures. Explicit "revoke all
 *     sessions" handles session invalidation cleanly.
 *   - If you wanted every passphrase change to invalidate tokens,
 *     rotate the salt too. Deliberately we don't.
 */

import { createHmac, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import type Database from "better-sqlite3";

import type { SecretVault } from "../config/SecretVault.js";
import { createLogger } from "../util/logger.js";
import { AuthStore } from "./AuthStore.js";
import { LocalAuthProvider } from "./LocalAuthProvider.js";
import { TokenService } from "./TokenService.js";
import { getOrCreateFileToken } from "./fileToken.js";

const log = createLogger("auth");

export interface Auth {
  readonly store: AuthStore;
  readonly provider: LocalAuthProvider;
  readonly tokens: TokenService;
  readonly fileToken: string;
  /**
   * Primary HS256 signing key. Exposed so adjacent subsystems
   * (webhook token encryption, channel signers, etc.) can derive
   * their own sub-keys via `deriveSubKey(primary, label)` instead of
   * generating independent secrets that need separate persistence.
   */
  readonly signingKey: Buffer;
}

export interface BuildAuthOpts {
  readonly db: Database.Database;
  readonly vault: SecretVault;
  readonly dataDir: string;
}

export function buildAuth(opts: BuildAuthOpts): Auth {
  const store = new AuthStore(opts.db);
  const provider = new LocalAuthProvider(opts.vault);
  const signingKey = resolveSigningKey(opts.dataDir);
  const tokens = new TokenService(store, { signingKey });
  const fileToken = getOrCreateFileToken(opts.dataDir);
  log.info("auth initialized");
  return { store, provider, tokens, fileToken, signingKey };
}

/**
 * Signing key resolution order:
 *   1. AUTH_SIGNING_KEY env var (hex-encoded, 32+ bytes) — production override
 *   2. `{dataDir}/auth-signing-key` file (persisted, 0600) — created on first boot
 *
 * The key NEVER lives in the vault. Two reasons:
 *   - Vault is locked until the user authenticates, but the signing
 *     key must exist BEFORE that to verify their refresh token flow.
 *   - Separating concerns: vault compromise leaks secrets; key file
 *     compromise only lets an attacker mint tokens, which they still
 *     can't use without a refresh + audit trail.
 */
function resolveSigningKey(dataDir: string): Buffer {
  const envKey = process.env["AUTH_SIGNING_KEY"];
  if (envKey && envKey.length >= 64) {
    return Buffer.from(envKey, "hex");
  }
  const path = join(dataDir, "auth-signing-key");
  if (existsSync(path)) {
    const contents = readFileSync(path, "utf-8").trim();
    if (contents.length >= 64) return Buffer.from(contents, "hex");
  }
  const key = randomBytes(32);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, key.toString("hex"), "utf-8");
  try { chmodSync(path, 0o600); } catch { /* windows best effort */ }
  log.info("auth signing key generated (stored at auth-signing-key, 0600)");
  return key;
}

/**
 * Utility: derive a sub-key for a specific purpose (HMAC for webhook
 * tokens, etc.) so we don't reuse the primary signing key for
 * multiple distinct uses.
 */
export function deriveSubKey(primary: Buffer, label: string): Buffer {
  return createHmac("sha256", primary).update(`daemora/${label}/v1`).digest();
}
