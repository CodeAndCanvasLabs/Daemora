/**
 * /api/config and /api/settings — read-only inspection + setting writes.
 *
 * Vault writes go through /api/vault (separate file) so this module
 * never sees secret values. Settings here are non-secret only.
 */

import type { Express, Request, Response } from "express";
import { z } from "zod";

import {
  secrets as secretsSchema,
  settings as settingsSchema,
  type SecretKey,
  type SettingKey,
} from "../../config/schema.js";
import { ValidationError } from "../../util/errors.js";
import type { ServerDeps } from "../index.js";

export function mountConfigRoutes(app: Express, deps: ServerDeps): void {
  /** Full inspection: every setting + every secret slot, with sources + hints. */
  app.get("/api/config", (_req: Request, res: Response) => {
    res.json({
      env: deps.cfg.env,
      fields: deps.cfg.inspect(),
    });
  });

  /**
   * Settings — flat KV object matching the JS backend shape.
   * The UI reads `data.vars.OPENAI_API_KEY` etc. directly.
   * Secret values are masked; non-secrets are returned as-is.
   */
  app.get("/api/settings", (_req: Request, res: Response) => {
    const SECRET_PATTERN = /(_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIAL|_AUTH|_PASSPHRASE|_API_KEY|_ACCESS_TOKEN)$/i;
    const vars: Record<string, string> = {};

    // Settings (non-secret)
    for (const s of deps.cfg.settings.inspectAll()) {
      vars[s.key] = s.value != null ? String(s.value) : "";
    }

    // Vault secrets (masked)
    const vaultActive = deps.cfg.vault.isUnlocked();
    if (vaultActive) {
      for (const key of deps.cfg.vault.keys()) {
        vars[key] = SECRET_PATTERN.test(key) ? "••••••••" : (deps.cfg.vault.get(key)?.reveal() ?? "");
      }
    }

    // Generic KV entries
    const allRows = deps.cfg.database.prepare(
      "SELECT key, value FROM settings_entries"
    ).all() as { key: string; value: string }[];
    for (const row of allRows) {
      if (!(row.key in vars)) {
        try {
          const parsed = JSON.parse(row.value);
          vars[row.key] = typeof parsed === "string" ? parsed : String(parsed);
        } catch {
          vars[row.key] = row.value;
        }
      }
    }

    res.json({ vars, vaultActive });
  });

  /**
   * Bulk update — the UI sends `PUT /api/settings` with
   * `{ updates: { KEY: value, ... } }`. Each key is routed to the
   * vault (if it's a secret) or the settings store (if it's a setting).
   * Unknown keys are stored as settings (forward-compat).
   */
  app.put("/api/settings", (req: Request, res: Response) => {
    const body = z.object({ updates: z.record(z.string(), z.unknown()) }).safeParse(req.body);
    if (!body.success) throw new ValidationError(body.error.message);

    const saved: string[] = [];
    for (const [key, value] of Object.entries(body.data.updates)) {
      if (key in secretsSchema) {
        // Route to vault — must be unlocked.
        if (!deps.cfg.vault.isUnlocked()) {
          throw new ValidationError("Vault is locked. Unlock before saving API keys.");
        }
        if (typeof value === "string" && value.length > 0) {
          deps.cfg.vault.set(key, value);
          saved.push(key);
        }
      } else if (key in settingsSchema) {
        deps.cfg.settings.set(key as SettingKey, value as never);
        saved.push(key);
      } else {
        // Forward-compat: store unknown keys via generic KV so the UI
        // can write arbitrary flags (SETUP_COMPLETED, voice prefs, etc.)
        deps.cfg.settings.setGeneric(key, value);
        saved.push(key);
      }
    }
    res.json({ ok: true, saved });
  });

  /**
   * Read a single key. Routes to vault for secrets (returns existence
   * + hint, never the value), settings store for everything else.
   */
  app.get("/api/settings/:key", (req: Request, res: Response) => {
    const key = req.params.key ?? "";
    if (key in secretsSchema) {
      const stored = deps.cfg.vault.isUnlocked() ? deps.cfg.vault.get(key) : undefined;
      return res.json({ key, isSet: deps.cfg.vault.has(key), hint: stored?.hint(), source: stored ? "vault" : "unset" });
    }
    if (!(key in settingsSchema)) throw new ValidationError(`Unknown setting: ${key}`);
    const settingKey = key as SettingKey;
    res.json({ key, value: deps.cfg.settings.get(settingKey), source: deps.cfg.source(settingKey) });
  });

  /** Write a single key. Routes to vault for secrets, settings store otherwise. */
  app.put("/api/settings/:key", (req: Request, res: Response) => {
    const key = req.params.key ?? "";
    const body = z.object({ value: z.unknown() }).safeParse(req.body);
    if (!body.success) throw new ValidationError(body.error.message);
    if (key in secretsSchema) {
      if (!deps.cfg.vault.isUnlocked()) throw new ValidationError("Vault is locked. Unlock before saving secrets.");
      const value = body.data.value;
      if (typeof value !== "string" || value.length === 0) throw new ValidationError("Secret value must be a non-empty string.");
      deps.cfg.vault.set(key, value);
      return res.json({ key, isSet: true, hint: deps.cfg.vault.get(key)?.hint(), source: "vault" });
    }
    if (!(key in settingsSchema)) throw new ValidationError(`Unknown setting: ${key}`);
    const settingKey = key as SettingKey;
    deps.cfg.settings.set(settingKey, body.data.value as never);
    res.json({ key, value: deps.cfg.settings.get(settingKey), source: "settings" });
  });

  /**
   * Remove a single key. For secrets that's a vault delete; for
   * settings it's a reset to the schema default.
   */
  app.delete("/api/settings/:key", (req: Request, res: Response) => {
    const key = req.params.key ?? "";
    if (key in secretsSchema) {
      if (!deps.cfg.vault.isUnlocked()) throw new ValidationError("Vault is locked. Unlock before deleting secrets.");
      const removed = deps.cfg.vault.delete(key);
      return res.json({ key, removed, source: "vault" });
    }
    if (!(key in settingsSchema)) throw new ValidationError(`Unknown setting: ${key}`);
    const settingKey = key as SettingKey;
    const wasSet = deps.cfg.settings.reset(settingKey);
    res.json({ key, value: deps.cfg.settings.get(settingKey), reset: wasSet });
  });
}
