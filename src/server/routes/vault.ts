/**
 * /api/vault — secret writes + unlock/lock.
 *
 * The vault NEVER returns secret values. Reads return only
 * existence flags + length hints (last 4 chars).
 *
 * Hard rules enforced here:
 *   - You can only set a key declared in the schema as a secret.
 *   - Pattern (e.g. /^sk-/ for OpenAI) is validated before storage.
 *   - Locked vault → 403 with the lock-prompt hint, never 500.
 */

import type { Express, Request, Response } from "express";
import { z } from "zod";

import { secrets as secretsSchema, type SecretKey } from "../../config/schema.js";
import { PermissionDeniedError, ValidationError } from "../../util/errors.js";
import type { ServerDeps } from "../index.js";

const unlockBody = z.object({ passphrase: z.string().min(8).max(256) });
const setBody = z.object({ value: z.string().min(1).max(8192) });

function requireUnlocked(deps: ServerDeps): void {
  if (!deps.cfg.vault.isUnlocked()) {
    throw new PermissionDeniedError("Vault is locked. POST /api/vault/unlock first.");
  }
}

function requireKnownSecret(deps: ServerDeps, key: string): asserts key is SecretKey {
  if (key in secretsSchema) return;
  // Channel secrets (declared in ChannelRegistry, not in secretsSchema)
  // are legitimate vault-write targets — e.g. TELEGRAM_BOT_TOKEN,
  // DISCORD_BOT_TOKEN, SLACK_BOT_TOKEN.
  for (const def of deps.channels.defs()) {
    if (def.requiredKeys.some((k) => k.key === key && k.secret)) return;
  }
  throw new ValidationError(`Unknown secret key: ${key}`);
}

export function mountVaultRoutes(app: Express, deps: ServerDeps): void {
  app.get("/api/vault/status", (_req, res) => {
    res.json({
      exists: deps.cfg.vault.exists(),
      unlocked: deps.cfg.vault.isUnlocked(),
      keys: deps.cfg.vault.isUnlocked() ? deps.cfg.vault.keys() : [],
    });
  });

  app.post("/api/vault/unlock", (req: Request, res: Response) => {
    const body = unlockBody.safeParse(req.body);
    if (!body.success) throw new ValidationError(body.error.message);
    deps.cfg.vault.unlock(body.data.passphrase);
    res.json({ ok: true, unlocked: true });
  });

  app.post("/api/vault/lock", (_req, res) => {
    // Single-user, single-tenant: the vault stays unlocked for the
    // process's lifetime. Locking it mid-run only stops the bg token
    // refresher and breaks integrations until the user reauths. The
    // process restart is the lock event. Endpoint kept as a no-op for
    // UI compatibility — returns the live unlocked state honestly.
    res.json({ ok: true, unlocked: deps.cfg.vault.isUnlocked() });
  });

  app.put("/api/vault/:key", (req: Request, res: Response) => {
    requireUnlocked(deps);
    const key = req.params.key as SecretKey;
    requireKnownSecret(deps, key);

    const body = setBody.safeParse(req.body);
    if (!body.success) throw new ValidationError(body.error.message);

    // Pattern check only applies to keys declared in the schema —
    // channel secrets (TELEGRAM_BOT_TOKEN, etc.) have no pattern.
    const def = secretsSchema[key];
    if (def?.pattern && !def.pattern.test(body.data.value)) {
      throw new ValidationError(`${key} doesn't match expected format ${def.pattern}`);
    }

    deps.cfg.vault.set(key, body.data.value);
    const stored = deps.cfg.vault.get(key);
    res.json({ key, isSet: true, hint: stored?.hint() });
  });

  app.delete("/api/vault/:key", (req: Request, res: Response) => {
    requireUnlocked(deps);
    const key = req.params.key as SecretKey;
    requireKnownSecret(deps, key);
    const removed = deps.cfg.vault.delete(key);
    res.json({ key, removed });
  });
}
