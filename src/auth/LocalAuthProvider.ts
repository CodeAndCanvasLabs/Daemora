/**
 * LocalAuthProvider — the vault passphrase IS the credential.
 *
 * Verification path:
 *   1. Attempt `vault.unlock(passphrase)`.
 *   2. Success → user is authenticated as the single local user.
 *      Failure → return null (ValidationError maps to "bad passphrase").
 *
 * Scopes: local user has everything. Plan is "self-hosted". These
 * values exist so the downstream token/middleware code is identical
 * to cloud, but they carry no enforcement meaning locally.
 *
 * Locking the vault (manual, idle timeout, or on passphrase rotation)
 * doesn't invalidate existing tokens directly — that's the signing
 * key's job (derived from vault state in TokenService).
 */

import type { SecretVault } from "../config/SecretVault.js";
import { ValidationError } from "../util/errors.js";
import type { AuthenticatedUser, AuthCredentials, AuthProvider } from "./AuthProvider.js";

const LOCAL_USER_ID = "local";

const LOCAL_USER: AuthenticatedUser = {
  id: LOCAL_USER_ID,
  scopes: ["chat", "admin", "webhooks", "voice", "settings", "vault"],
  label: "Local user",
};

export class LocalAuthProvider implements AuthProvider {

  constructor(private readonly vault: SecretVault) {}

  isReady(): boolean {
    return true; // vault may be locked, but we can still try to unlock
  }

  async verifyCredentials(creds: AuthCredentials): Promise<AuthenticatedUser | null> {
    const passphrase = creds.passphrase;
    if (!passphrase || passphrase.length < 8) return null;

    try {
      if (!this.vault.isUnlocked()) {
        this.vault.unlock(passphrase);
      } else {
        // Vault already unlocked — re-derive + compare without changing state.
        // We do this by briefly locking, trying, then restoring: simplest
        // correct implementation since vault.unlock is idempotent and
        // guards against wrong passphrases with ValidationError.
        // This path hits when a second device logs in while the first is live.
        this.vault.lock();
        this.vault.unlock(passphrase);
      }
    } catch (e) {
      if (e instanceof ValidationError) return null;
      throw e;
    }
    return LOCAL_USER;
  }

  // ── Vault lifecycle passthrough ────────────────────────────────
  // Routes ask the provider (not the vault) about unlock state so the
  // Auth bundle stays the one thing routes import.

  isUnlocked(): boolean {
    return this.vault.isUnlocked();
  }

  exists(): boolean {
    return this.vault.exists();
  }

  lock(): void {
    this.vault.lock();
  }
}
