/**
 * /api/integrations — OAuth-backed integration management.
 *
 * Endpoints:
 *   GET    /api/integrations                          — availability + connected accounts
 *   POST   /api/integrations/:integration/start       — begin OAuth; returns { url, state }
 *   GET    /oauth/providers/:provider/callback        — provider redirect target (preferred)
 *   GET    /oauth/integrations/:integration/callback  — legacy per-integration callback (compat)
 *   DELETE /api/integrations/:integration/:accountId  — revoke connection
 *
 * Callback is a GET redirect from the provider (Twitter / Google / Meta / …).
 * It exchanges the authorization code for tokens and then redirects the
 * browser back to /integrations?connected=<id>&label=... so the UI
 * can show a success state.
 *
 * Why per-provider instead of per-integration in the URL: a single OAuth
 * client owns all integrations for one provider (youtube + gmail +
 * google_calendar all ride Google's client), so they all need to share
 * one Authorized redirect URI in that provider's console. The per-
 * integration path is kept as a fallback so already-registered URIs
 * (e.g. `…/oauth/integrations/youtube/callback`) keep working.
 */

import type { Express, Request, Response } from "express";
import { z } from "zod";

import type { ConfigManager } from "../../config/ConfigManager.js";
import { NotFoundError, ValidationError } from "../../util/errors.js";
import type { IntegrationManager } from "../../integrations/IntegrationManager.js";
import {
  extraScopesVaultKey,
  redirectUriOverrideVaultKey,
  readRedirectUriOverride,
} from "../../integrations/keys.js";
import type { IntegrationId, ProviderId } from "../../integrations/types.js";
import { createLogger } from "../../util/logger.js";

const log = createLogger("integrations.routes");

const INTEGRATION_IDS = new Set<IntegrationId>([
  "twitter",
  "youtube",
  "facebook",
  "instagram",
  "github",
  "notion",
  "gmail",
  "google_calendar",
  "reddit",
  "linkedin",
  "tiktok",
]);

const startBody = z.object({
  /**
   * Where the browser is calling from. The callback URL we send to the
   * provider uses the server's own public URL (tunnel), so this is
   * informational only — the UI passes its origin so the callback can
   * redirect back to the right /integrations page.
   */
  uiOrigin: z.string().url().optional(),
});

export interface IntegrationRoutesDeps {
  readonly integrations: IntegrationManager;
  readonly getPublicUrl: () => string;
  /** For reading/writing OAuth client creds into the vault. */
  readonly cfg: ConfigManager;
  /** Loopback file token to bounce back through /integrations page. */
  readonly getUiToken?: () => string | undefined;
}

/**
 * Per-provider map from provider id → vault key names for the client
 * credentials, plus which integrations ride on that provider (so the
 * UI can show "shared with X and Y" hints) and whether a client secret
 * is needed at all (Twitter PKCE does not use a secret).
 */
interface ProviderCredSpec {
  readonly provider: ProviderId;
  readonly clientIdKey: string;
  readonly clientSecretKey: string | null;
  /** When true, `clientSecretKey` is shown in the UI but blank is accepted
   *  on save (e.g. Twitter — secret is only needed for Confidential apps). */
  readonly clientSecretOptional?: boolean;
  /** Integrations that consume this provider's credentials. */
  readonly sharedWith: readonly IntegrationId[];
  /** Friendly label for the client_id field (e.g. TikTok calls it client_key). */
  readonly clientIdLabel: string;
  /** Link to the developer console where the user registers an app. */
  readonly consoleUrl: string;
}

const PROVIDER_CREDS: Record<ProviderId, ProviderCredSpec> = {
  twitter: {
    provider: "twitter",
    clientIdKey: "TWITTER_CLIENT_ID",
    // X supports both Public (PKCE-only) and Confidential (PKCE + Basic
    // auth) OAuth 2.0 apps. We surface the secret field but allow blank —
    // populate only when the X portal app is type "Confidential".
    clientSecretKey: "TWITTER_CLIENT_SECRET",
    clientSecretOptional: true,
    sharedWith: ["twitter"],
    clientIdLabel: "Client ID",
    consoleUrl: "https://developer.twitter.com/en/portal/dashboard",
  },
  google: {
    provider: "google",
    clientIdKey: "GOOGLE_CLIENT_ID",
    clientSecretKey: "GOOGLE_CLIENT_SECRET",
    sharedWith: ["youtube", "gmail", "google_calendar"],
    clientIdLabel: "Client ID",
    consoleUrl: "https://console.cloud.google.com/apis/credentials",
  },
  meta: {
    provider: "meta",
    clientIdKey: "META_APP_ID",
    clientSecretKey: "META_APP_SECRET",
    sharedWith: ["facebook", "instagram"],
    clientIdLabel: "App ID",
    consoleUrl: "https://developers.facebook.com/apps",
  },
  github: {
    provider: "github",
    clientIdKey: "GITHUB_CLIENT_ID",
    clientSecretKey: "GITHUB_CLIENT_SECRET",
    sharedWith: ["github"],
    clientIdLabel: "Client ID",
    consoleUrl: "https://github.com/settings/apps",
  },
  notion: {
    provider: "notion",
    clientIdKey: "NOTION_CLIENT_ID",
    clientSecretKey: "NOTION_CLIENT_SECRET",
    sharedWith: ["notion"],
    clientIdLabel: "OAuth Client ID",
    consoleUrl: "https://www.notion.so/my-integrations",
  },
  reddit: {
    provider: "reddit",
    clientIdKey: "REDDIT_CLIENT_ID",
    clientSecretKey: "REDDIT_CLIENT_SECRET",
    sharedWith: ["reddit"],
    clientIdLabel: "Client ID",
    consoleUrl: "https://www.reddit.com/prefs/apps",
  },
  linkedin: {
    provider: "linkedin",
    clientIdKey: "LINKEDIN_CLIENT_ID",
    clientSecretKey: "LINKEDIN_CLIENT_SECRET",
    sharedWith: ["linkedin"],
    clientIdLabel: "Client ID",
    consoleUrl: "https://www.linkedin.com/developers/apps",
  },
  tiktok: {
    provider: "tiktok",
    clientIdKey: "TIKTOK_CLIENT_KEY",
    clientSecretKey: "TIKTOK_CLIENT_SECRET",
    sharedWith: ["tiktok"],
    clientIdLabel: "Client Key",
    consoleUrl: "https://developers.tiktok.com/apps",
  },
};

export function mountIntegrationRoutes(app: Express, deps: IntegrationRoutesDeps): void {
  app.get("/api/integrations", (_req: Request, res: Response) => {
    res.json({
      availability: deps.integrations.availability(),
      accounts: deps.integrations.listAccounts(),
    });
  });

  app.post("/api/integrations/:integration/start", (req: Request, res: Response) => {
    const integration = parseIntegration(req);
    const body = startBody.safeParse(req.body ?? {});
    if (!body.success) throw new ValidationError(body.error.message);

    // Build the callback URL from whichever origin the USER'S browser
    // is on — not the server's public URL. If they loaded Daemora at
    // localhost:8081, Google gets localhost:8081 as the redirect URI;
    // if they're going through a tunnel, Google gets the tunnel URL.
    // Falls back to getPublicUrl() when uiOrigin isn't supplied (e.g.
    // from a CLI-driven connect).
    //
    // The URL is keyed by PROVIDER, not integration, so one registered
    // redirect URI in each provider's console covers every integration
    // that rides that provider (youtube + gmail + calendar all share
    // `/oauth/providers/google/callback`).
    // Precedence: per-integration pinned override > UI browser origin >
    // hosted public URL. The pin lets users register a tunnel URL in
    // their provider portal once and stop caring about which browser
    // tab they're in (TikTok specifically rejects http://localhost).
    const provider = deps.integrations.providerFor(integration);
    const pinned = readRedirectUriOverride(deps.cfg, integration);
    const redirectUri = pinned
      ?? buildCallbackUrl(body.data.uiOrigin ?? deps.getPublicUrl(), provider);
    log.info(
      { integration, provider, redirectUri, source: pinned ? "pinned" : "uiOrigin" },
      "OAuth start — exact redirect_uri being sent to provider",
    );
    const { url, state } = deps.integrations.startAuth(integration, redirectUri);
    // Remember the UI origin so the callback can redirect back. Keyed
    // by state to survive the round-trip.
    if (body.data.uiOrigin) rememberUiOrigin(state, body.data.uiOrigin);
    res.json({ url, state });
  });

  // The callback hits this route directly from the provider's redirect
  // — no auth headers, since the browser is following a 302 from
  // twitter.com / facebook.com / google.com. Lives under /oauth/ so
  // the requireAuth middleware can bypass it by prefix without
  // opening up the rest of /api/integrations.
  //
  // Preferred unified route — ONE URI to register across every
  // provider console regardless of which integration. The integration
  // is always recovered from the `pending` map via `state`, so the URL
  // carries no identifying path segment at all.
  app.get("/oauth/callback", (req: Request, res: Response) =>
    handleCallback(req, res),
  );

  // Legacy per-provider route — kept so already-registered URIs like
  // `/oauth/providers/google/callback` keep working while users migrate.
  app.get("/oauth/providers/:provider/callback", (req: Request, res: Response) =>
    handleCallback(req, res),
  );

  // Legacy per-integration route — same compat story for early
  // YouTube installs that registered `/oauth/integrations/youtube/callback`.
  app.get("/oauth/integrations/:integration/callback", (req: Request, res: Response) =>
    handleCallback(req, res),
  );

  async function handleCallback(req: Request, res: Response): Promise<void> {
    const state = typeof req.query["state"] === "string" ? req.query["state"] : "";
    const code = typeof req.query["code"] === "string" ? req.query["code"] : "";
    const providerError = typeof req.query["error"] === "string" ? req.query["error"] : "";
    // For error messages only — the real integration id comes from `state`.
    const pathLabel = req.params["provider"] ?? req.params["integration"] ?? "unknown";

    const uiOrigin = consumeUiOrigin(state) ?? req.protocol + "://" + (req.get("host") ?? "localhost");
    const redirectBack = (qs: string): void => {
      res.redirect(302, `${uiOrigin.replace(/\/+$/, "")}/integrations?${qs}`);
    };

    if (providerError) {
      redirectBack(`error=${encodeURIComponent(providerError)}&integration=${pathLabel}`);
      return;
    }
    if (!state || !code) {
      redirectBack(`error=missing_state_or_code&integration=${pathLabel}`);
      return;
    }
    try {
      const { integration, accountLabel } = await deps.integrations.completeAuth(state, code);
      redirectBack(
        `connected=${integration}&label=${encodeURIComponent(accountLabel)}`,
      );
    } catch (e) {
      redirectBack(
        `error=${encodeURIComponent((e as Error).message.slice(0, 200))}&integration=${pathLabel}`,
      );
    }
  }

  // NOTE: DELETE /api/integrations/:integration/:accountId is declared
  // AFTER the more-specific `/credentials` path below — otherwise Express
  // matches `/credentials` against `:accountId` and the wrong handler runs.
  // (Express matches in declaration order; we put specific paths first.)

  // ── Per-integration OAuth client credentials (UI-managed) ──────────
  //
  // Users register their own OAuth apps in each provider's console and
  // paste the client id / secret here. Values are persisted encrypted
  // in the vault; we never return them again (GET only exposes a
  // boolean). Extra scopes beyond the defaults are stored as a JSON
  // array under `<INTEGRATION>_EXTRA_SCOPES`.

  app.get("/api/integrations/:integration/credentials", (req: Request, res: Response) => {
    const integration = parseIntegration(req);
    const provider = deps.integrations.providerFor(integration);
    const spec = PROVIDER_CREDS[provider];
    const vault = deps.cfg.vault;
    const hasId = vault.isUnlocked() && vault.has(spec.clientIdKey);
    const hasSecret = spec.clientSecretKey
      ? vault.isUnlocked() && vault.has(spec.clientSecretKey)
      : true;
    // For "configured" we treat optional secrets as never-required, so a
    // Public-client X app reads as configured with just the client_id.
    const secretRequired = spec.clientSecretKey !== null && !spec.clientSecretOptional;
    const origin = deps.getPublicUrl();
    const redirectUri = buildCallbackUrl(origin, provider);
    const legacyRedirectUri = `${origin.replace(/\/+$/, "")}/oauth/integrations/${integration}/callback`;
    res.json({
      integration,
      provider,
      configured: hasId && (!secretRequired || hasSecret),
      hasClientId: hasId,
      hasClientSecret: hasSecret,
      requiresClientSecret: secretRequired,
      // Show the secret field even when optional, so the user can fill
      // it in for Confidential X apps without re-deploying the UI.
      showsClientSecret: spec.clientSecretKey !== null,
      clientIdLabel: spec.clientIdLabel,
      clientSecretLabel: spec.clientSecretKey
        ? (spec.clientSecretOptional ? "Client Secret (optional — only for Confidential apps)" : "Client Secret")
        : null,
      consoleUrl: spec.consoleUrl,
      redirectUri,
      legacyRedirectUri,
      sharedWith: spec.sharedWith,
      defaultScopes: deps.integrations.defaultScopesFor(integration),
      extraScopes: readExtraScopesList(deps.cfg, integration),
      // Echo the pinned redirect URI back so the UI can pre-fill the
      // override field. Empty string when the user hasn't pinned one.
      redirectUriOverride: readRedirectUriOverride(deps.cfg, integration) ?? "",
    });
  });

  // The form pattern is "leave blank to keep existing value" — empty or
  // missing fields mean "don't touch what's in the vault". Required-on-
  // first-save is enforced in the handler below, where we know whether
  // an existing entry is already present.
  const credsBody = z.object({
    clientId: z.string().max(512).optional(),
    clientSecret: z.string().max(512).optional(),
    extraScopes: z.array(z.string().min(1).max(256)).max(64).optional(),
    /** Optional pinned redirect URI — bypasses uiOrigin derivation.
     *  Must be a fully-qualified URL with scheme + host. Empty string
     *  clears the override on the next save. */
    redirectUriOverride: z.string().max(512).optional(),
  });

  /**
   * Heuristic: real OAuth scopes are either short (< 32 chars) OR contain
   * a structural separator (`.`, `:`, or `/`). Bare 32+ char base64-url
   * blobs are almost always credentials someone pasted by accident — we
   * reject them so they don't end up appended to the auth URL's scope
   * param and break the OAuth handshake.
   */
  function looksLikeCredentialNotScope(scope: string): boolean {
    if (scope.length < 32) return false;
    if (/[.:/]/.test(scope)) return false;
    return /^[A-Za-z0-9_-]+$/.test(scope);
  }

  app.post("/api/integrations/:integration/credentials", (req: Request, res: Response) => {
    const integration = parseIntegration(req);
    const provider = deps.integrations.providerFor(integration);
    const spec = PROVIDER_CREDS[provider];
    const vault = deps.cfg.vault;
    if (!vault.isUnlocked()) {
      res.status(503).json({ code: "vault_locked", error: "Unlock the vault before saving credentials." });
      return;
    }

    const body = credsBody.safeParse(req.body ?? {});
    if (!body.success) throw new ValidationError(body.error.message);

    // Client ID — "leave blank to keep" semantics. Only write when a
    // non-empty value is supplied. If the vault is empty AND the user
    // didn't provide one, refuse — can't save a config with no client_id.
    const clientIdInput = body.data.clientId?.trim();
    if (clientIdInput) {
      vault.set(spec.clientIdKey, clientIdInput);
    } else if (!vault.has(spec.clientIdKey)) {
      throw new ValidationError(`${integration}: ${spec.clientIdLabel} is required.`);
    }

    if (spec.clientSecretKey) {
      const secret = body.data.clientSecret?.trim();
      if (secret) {
        vault.set(spec.clientSecretKey, secret);
      } else if (spec.clientSecretOptional) {
        // For Twitter (optional secret): a blank field on subsequent
        // saves means "leave existing alone" rather than "clear" — only
        // an explicit clear via the Clear button wipes it. This keeps
        // the "leave blank to keep" pattern consistent with client_id.
        // No-op here.
      } else if (!vault.has(spec.clientSecretKey)) {
        throw new ValidationError(`${integration}: client secret is required for this provider.`);
      }
    }

    // Extra scopes are stored per INTEGRATION (not per provider) so
    // the user can, say, add a Gmail-only scope without touching the
    // YouTube scope set. We validate the format here to catch the
    // common mistake of pasting a credential into this field.
    if (body.data.extraScopes !== undefined) {
      const cleaned = Array.from(new Set(body.data.extraScopes.map((s) => s.trim()).filter(Boolean)));
      const offenders = cleaned.filter(looksLikeCredentialNotScope);
      if (offenders.length > 0) {
        throw new ValidationError(
          `${integration}: extra scopes contain what looks like a credential, not a scope: ` +
          `${offenders.map((s) => `"${s.slice(0, 8)}…${s.slice(-4)}"`).join(", ")}. ` +
          `If you meant to set a Client ID or Client Secret, paste it in those fields instead.`,
        );
      }
      if (cleaned.length > 0) vault.set(extraScopesVaultKey(integration), JSON.stringify(cleaned));
      else vault.delete(extraScopesVaultKey(integration));
    }

    // Pinned redirect-URI override. Empty / undefined = no override
    // (uiOrigin-based). Anything else must look like a real URL.
    if (body.data.redirectUriOverride !== undefined) {
      const override = body.data.redirectUriOverride.trim();
      if (override === "") {
        vault.delete(redirectUriOverrideVaultKey(integration));
      } else {
        try {
          const u = new URL(override);
          if (u.protocol !== "http:" && u.protocol !== "https:") {
            throw new ValidationError(`Redirect URI must be http(s): ${override}`);
          }
        } catch (e) {
          if (e instanceof ValidationError) throw e;
          throw new ValidationError(`Redirect URI is not a valid URL: ${override}`);
        }
        vault.set(redirectUriOverrideVaultKey(integration), override);
      }
    }

    log.info({ integration, provider, hasSecret: !!body.data.clientSecret, extras: body.data.extraScopes?.length ?? 0 }, "integration credentials saved");
    res.json({
      ok: true,
      configured: true,
      sharedWith: spec.sharedWith,
    });
  });

  app.delete("/api/integrations/:integration/credentials", (req: Request, res: Response) => {
    const integration = parseIntegration(req);
    const provider = deps.integrations.providerFor(integration);
    const spec = PROVIDER_CREDS[provider];
    const vault = deps.cfg.vault;
    if (!vault.isUnlocked()) {
      res.status(503).json({ code: "vault_locked", error: "Unlock the vault before modifying credentials." });
      return;
    }
    vault.delete(spec.clientIdKey);
    if (spec.clientSecretKey) vault.delete(spec.clientSecretKey);
    vault.delete(extraScopesVaultKey(integration));
    vault.delete(redirectUriOverrideVaultKey(integration));
    log.info({ integration, provider }, "integration credentials cleared");
    res.json({ ok: true });
  });

  // Wildcard `:accountId` route — registered LAST so the specific
  // `/credentials` paths above always win on dispatch.
  app.delete("/api/integrations/:integration/:accountId", (req: Request, res: Response) => {
    const integration = parseIntegration(req);
    const accountId = req.params["accountId"];
    if (!accountId) throw new ValidationError("Missing accountId");
    const accounts = deps.integrations.listAccounts(integration);
    if (!accounts.some((a) => a.accountId === accountId)) {
      throw new NotFoundError(`No ${integration} account ${accountId} connected`);
    }
    deps.integrations.disconnect(integration, accountId);
    res.json({ ok: true });
  });
}

function readExtraScopesList(cfg: ConfigManager, integration: IntegrationId): readonly string[] {
  if (!cfg.vault.isUnlocked()) return [];
  const raw = cfg.vault.get(extraScopesVaultKey(integration))?.reveal();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

function parseIntegration(req: Request): IntegrationId {
  const raw = req.params["integration"];
  if (!raw || !INTEGRATION_IDS.has(raw as IntegrationId)) {
    throw new ValidationError(`Unknown integration: ${raw}`);
  }
  return raw as IntegrationId;
}

function buildCallbackUrl(publicUrl: string, _provider: string): string {
  // Unified callback — one URI for every provider. Integration is
  // recovered from `state` inside the handler, so the URL doesn't need
  // to carry it. `_provider` is kept in the signature only because the
  // caller (start route) still passes it; its value no longer affects
  // the URL emitted.
  const base = publicUrl.replace(/\/+$/, "");
  return `${base}/oauth/callback`;
}

/** In-memory UI origin map keyed by state. 10-min TTL. */
const UI_ORIGINS = new Map<string, { origin: string; at: number }>();
const UI_ORIGIN_TTL_MS = 10 * 60_000;

function rememberUiOrigin(state: string, origin: string): void {
  UI_ORIGINS.set(state, { origin, at: Date.now() });
  // Lazy GC.
  if (UI_ORIGINS.size > 100) {
    const cutoff = Date.now() - UI_ORIGIN_TTL_MS;
    for (const [s, v] of UI_ORIGINS) if (v.at < cutoff) UI_ORIGINS.delete(s);
  }
}

function consumeUiOrigin(state: string): string | null {
  const entry = UI_ORIGINS.get(state);
  if (!entry) return null;
  UI_ORIGINS.delete(state);
  if (Date.now() - entry.at > UI_ORIGIN_TTL_MS) return null;
  return entry.origin;
}
