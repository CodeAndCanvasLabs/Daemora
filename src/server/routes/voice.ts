/**
 * /api/voice/* — LiveKit voice system endpoints.
 *
 * Uses configured values from settings/vault/env — NOT hardcoded.
 * LiveKit --dev mode uses "devkey"/"secret" as defaults, which we
 * match when no explicit config is set.
 *
 * Voice config chain:
 *   1. Vault keys for STT/TTS providers (GROQ_API_KEY, OPENAI_API_KEY, etc.)
 *   2. Settings for provider selection (DAEMORA_STT_PROVIDER, DAEMORA_TTS_PROVIDER)
 *   3. Env vars for LiveKit connection (LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
 */

import type { Express, Request, Response } from "express";

import { generateLiveKitToken } from "../../voice/LiveKitToken.js";
import type { ServerDeps } from "../index.js";

/** Read LiveKit config from settings/vault (database), falling back to env then defaults. */
function getLiveKitConfig(deps: ServerDeps): { url: string; apiKey: string; apiSecret: string } {
  // URL from settings (database), then env, then default
  const url = deps.cfg.setting("LIVEKIT_URL")
    ?? process.env["LIVEKIT_URL"]
    ?? "ws://127.0.0.1:7880";

  // API key/secret from vault (database), then env, then --dev defaults
  const apiKey = deps.cfg.vault.get("LIVEKIT_API_KEY")?.reveal()
    ?? process.env["LIVEKIT_API_KEY"]
    ?? "devkey";
  const apiSecret = deps.cfg.vault.get("LIVEKIT_API_SECRET")?.reveal()
    ?? process.env["LIVEKIT_API_SECRET"]
    ?? "secret";

  return { url, apiKey, apiSecret };
}

/**
 * Rewrite the LiveKit URL host to match the browser's own hostname.
 *
 * Why: Chrome's Private Network Access (PNA) blocks requests from
 * `http://localhost:8081` to `http://127.0.0.1:7880` (localhost is
 * treated as a "local" origin and 127.0.0.1 is considered "private
 * network", requiring preflight with special PNA headers). Returning
 * `ws://localhost:7880` when the UI is on `localhost:*` dodges PNA
 * entirely because browser sees same hostname → same network zone.
 *
 * Only rewrites loopback hosts (127.0.0.1, localhost, ::1). A non-loopback
 * configured URL (e.g. a cloud LiveKit) is returned untouched.
 */
function clientFacingLiveKitUrl(configured: string, req: Request): string {
  try {
    // Accept both ws://host:port and http://host:port style URLs.
    const parsed = new URL(configured);
    const host = parsed.hostname.toLowerCase();
    const loopbacks = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
    if (!loopbacks.has(host)) return configured;

    // Pull the hostname the browser used to reach us.
    const hostHeader = req.headers.host ?? ""; // e.g. "localhost:8081"
    const colon = hostHeader.lastIndexOf(":");
    const browserHost = colon > 0 ? hostHeader.slice(0, colon) : hostHeader;
    if (!browserHost) return configured;
    parsed.hostname = browserHost;
    // URL.toString adds a trailing slash; LiveKit client dislikes that.
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return configured;
  }
}

/**
 * Read the live voice provider config from settings. Returns exactly
 * what's in the DB — no hardcoded fallbacks masking stale values. The
 * caller (token endpoint / spawnVoiceWorker) uses these to compose
 * both the informational response and the worker's env.
 */
function getVoiceConfig(deps: ServerDeps): {
  sttProvider: string; sttModel: string;
  ttsProvider: string; ttsModel: string; ttsVoice: string;
  llmModel: string;
} {
  const s = deps.cfg.settings;
  const sttProvider = (s.getGeneric("DAEMORA_STT_PROVIDER") as string | undefined) ?? "";
  const sttModel    = (s.getGeneric("STT_MODEL")            as string | undefined) ?? "";
  const ttsProvider = (s.getGeneric("DAEMORA_TTS_PROVIDER") as string | undefined) ?? "";
  const ttsModel    = (s.getGeneric("TTS_MODEL")            as string | undefined) ?? "";
  const ttsVoice    = (s.getGeneric("TTS_VOICE")            as string | undefined) ?? "";

  const defaultModel = deps.cfg.setting("DEFAULT_MODEL");
  const llmInference = defaultModel
    ? (defaultModel.includes("/") ? defaultModel : defaultModel.replace(":", "/"))
    : "openai/gpt-4o-mini";

  return { sttProvider, sttModel, ttsProvider, ttsModel, ttsVoice, llmModel: llmInference };
}

/**
 * Settings keys that, when changed, require the worker to reboot so
 * the child process picks up the new values. Env-capturing workers
 * don't hot-reload — we have to respawn them.
 */
const VOICE_SETTING_KEYS = new Set([
  "DAEMORA_STT_PROVIDER", "STT_MODEL",
  "DAEMORA_TTS_PROVIDER", "TTS_MODEL", "TTS_VOICE",
  "DEFAULT_MODEL",
]);

/**
 * Vault keys that change the worker's credentials. Swapping ElevenLabs
 * keys mid-session means the running worker still uses the old key, so
 * these also force a restart.
 */
const VOICE_VAULT_KEYS = new Set([
  "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GROQ_API_KEY",
  "ELEVENLABS_API_KEY", "CARTESIA_API_KEY", "DEEPGRAM_API_KEY",
  "ASSEMBLYAI_API_KEY", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET",
]);

export function mountVoiceRoutes(
  app: Express,
  deps: ServerDeps,
): void {
  // ── Token ─────────────────────────────────────────────────────
  app.post("/api/voice/token", async (req: Request, res: Response) => {
    const identity = String(req.body?.identity ?? `user-${Date.now()}`);
    const room = String(req.body?.room ?? "daemora-local");
    const lk = getLiveKitConfig(deps);
    const voiceCfg = getVoiceConfig(deps);

    const token = await generateLiveKitToken({
      identity, room, apiKey: lk.apiKey, apiSecret: lk.apiSecret,
    });

    // Explicitly dispatch our named agent ("daemora") into this room.
    // Without this, the LiveKit server only auto-dispatches to rooms
    // created AFTER the worker has registered — if the user joins
    // before the worker is ready (always true on cold starts), the
    // agent never shows up and the orb hangs on "Listening".
    try {
      const { AgentDispatchClient } = await import("livekit-server-sdk");
      const client = new AgentDispatchClient(lk.url, lk.apiKey, lk.apiSecret);
      const existing = await client.listDispatch(room).catch(() => []);
      const alreadyDispatched = existing.some((d) => d.agentName === "daemora");
      if (!alreadyDispatched) {
        await client.createDispatch(room, "daemora");
      }
    } catch (e) {
      console.error(`[voice] agent dispatch failed: ${(e as Error).message}`);
    }

    res.json({
      token,
      url: clientFacingLiveKitUrl(lk.url, req),
      room, identity,
      voice: {
        stt: { provider: voiceCfg.sttProvider, model: voiceCfg.sttModel },
        tts: { provider: voiceCfg.ttsProvider, model: voiceCfg.ttsModel, voice: voiceCfg.ttsVoice },
        llm: voiceCfg.llmModel,
      },
    });
  });

  app.get("/api/voice/token", async (req: Request, res: Response) => {
    const identity = String(req.query["identity"] ?? `user-${Date.now()}`);
    const room = String(req.query["room"] ?? "daemora-local");
    const lk = getLiveKitConfig(deps);

    const token = await generateLiveKitToken({
      identity, room, apiKey: lk.apiKey, apiSecret: lk.apiSecret,
    });

    res.json({ token, url: clientFacingLiveKitUrl(lk.url, req), room, identity });
  });

  // ── Voice config (for Settings page) ──────────────────────────
  app.get("/api/voice/config", (_req: Request, res: Response) => {
    const lk = getLiveKitConfig(deps);
    const voiceCfg = getVoiceConfig(deps);
    res.json({
      livekit: { url: lk.url, configured: lk.apiKey !== "devkey" },
      stt: { provider: voiceCfg.sttProvider, model: voiceCfg.sttModel },
      tts: { provider: voiceCfg.ttsProvider, model: voiceCfg.ttsModel, voice: voiceCfg.ttsVoice },
      llm: voiceCfg.llmModel,
    });
  });

  // ── Voice worker management ────────────────────────────────────
  //
  // The LiveKit voice worker is a child process (`dist/voice-worker.mjs`)
  // because `@livekit/rtc-node` crashes under tsx. Cold-starting the
  // worker takes ~25s (native module load + silero/turn-detector ONNX
  // load). That's way too long for "click mic → talk" UX. So we spawn
  // the worker at server boot, keep it running, and auto-respawn on
  // exit. The UI's `/api/voice/sidecar/start` call becomes a cheap
  // "is-it-alive?" check.
  let voiceWorkerProc: import("node:child_process").ChildProcess | null = null;
  let respawnBlocked = false;

  async function spawnVoiceWorker(): Promise<void> {
    if (voiceWorkerProc && !voiceWorkerProc.killed && voiceWorkerProc.exitCode === null) return;

    const { spawn: spawnProc } = await import("node:child_process");
    const { fileURLToPath: toPath } = await import("node:url");
    const voiceWorkerPath = toPath(new URL("../../../dist/voice-worker.mjs", import.meta.url));
    const lk = getLiveKitConfig(deps);
    const vc = getVoiceConfig(deps);

    const providerKeys: Record<string, string> = {};
    if (deps.cfg.vault.isUnlocked()) {
      for (const key of deps.cfg.vault.keys()) {
        const secret = deps.cfg.vault.get(key);
        if (secret) providerKeys[key] = secret.reveal();
      }
    }

    const sttProvider = (deps.cfg.settings.getGeneric("DAEMORA_STT_PROVIDER") as string | undefined) ?? vc.sttProvider;
    const ttsProvider = (deps.cfg.settings.getGeneric("DAEMORA_TTS_PROVIDER") as string | undefined) ?? vc.ttsProvider;
    const sttModel = (deps.cfg.settings.getGeneric("STT_MODEL") as string | undefined) ?? "";
    const ttsModel = (deps.cfg.settings.getGeneric("TTS_MODEL") as string | undefined) ?? "";
    const ttsVoice = (deps.cfg.settings.getGeneric("TTS_VOICE") as string | undefined) ?? vc.ttsVoice;

    const proc = spawnProc("node", [voiceWorkerPath, "dev"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...providerKeys,
        LIVEKIT_URL: lk.url, LIVEKIT_API_KEY: lk.apiKey, LIVEKIT_API_SECRET: lk.apiSecret,
        DAEMORA_HTTP: `http://127.0.0.1:${deps.cfg.env.port}`,
        DAEMORA_STT_PROVIDER: sttProvider,
        DAEMORA_TTS_PROVIDER: ttsProvider,
        STT_MODEL: sttModel,
        TTS_MODEL: ttsModel,
        TTS_VOICE: ttsVoice,
        DAEMORA_VOICE_LLM: vc.llmModel,
      },
    });
    proc.stdout?.on("data", (c: Buffer) => { const s = c.toString().trim(); if (s) console.log(`[voice] ${s}`); });
    proc.stderr?.on("data", (c: Buffer) => { const s = c.toString().trim(); if (s) console.error(`[voice] ${s}`); });
    proc.on("exit", (code) => {
      console.log(`[voice] worker exited (${code}) — auto-respawning in 2s`);
      voiceWorkerProc = null;
      // Auto-respawn unless we've been explicitly stopped (sidecar/stop
      // or server shutdown). Give a short delay so rtc-node's C++
      // teardown flushes before we re-launch.
      if (!respawnBlocked) {
        setTimeout(() => { void spawnVoiceWorker(); }, 2000);
      }
    });
    voiceWorkerProc = proc;
    console.log(`[voice] worker spawned pid=${proc.pid}`);
  }

  /**
   * Respawn the worker so it picks up new settings / vault changes.
   * The child process captures env at spawn time — there's no hot
   * reload path. `respawnBlocked` stays false so the normal exit->
   * auto-respawn chain kicks in once the kill signal has cleaned up
   * rtc-node's native resources.
   */
  async function restartVoiceWorker(reason: string): Promise<void> {
    if (!deps.cfg.vault.isUnlocked()) {
      console.log(`[voice] skip restart (${reason}) — vault is locked`);
      return;
    }
    if (voiceWorkerProc && !voiceWorkerProc.killed) {
      console.log(`[voice] restart requested (${reason}) — killing pid=${voiceWorkerProc.pid}`);
      voiceWorkerProc.kill("SIGTERM");
      // Don't block respawn — the exit handler will relaunch.
      // Force-kill after 5s if the process hangs on rtc-node teardown.
      const procRef = voiceWorkerProc;
      setTimeout(() => {
        if (procRef && !procRef.killed && procRef.exitCode === null) {
          console.warn("[voice] SIGTERM ignored — SIGKILL fallback");
          procRef.kill("SIGKILL");
        }
      }, 5000).unref();
      return;
    }
    // No process running — just spawn one.
    await spawnVoiceWorker();
  }

  // Debounce rapid config writes (Settings UI saves multiple keys at
  // once). Collapse them into one restart.
  let restartPending: ReturnType<typeof setTimeout> | null = null;
  const scheduleRestart = (reason: string): void => {
    if (restartPending) clearTimeout(restartPending);
    restartPending = setTimeout(() => {
      restartPending = null;
      void restartVoiceWorker(reason).catch((e) => {
        console.error(`[voice] restart failed: ${(e as Error).message}`);
      });
    }, 500);
    if (restartPending && "unref" in restartPending) restartPending.unref();
  };

  // Subscribe to ConfigManager change events. The voice worker captures
  // STT/TTS/LLM settings + provider API keys at spawn time, so any
  // change has to propagate through a restart. We filter to voice-
  // relevant keys to avoid thrashing on unrelated config edits.
  deps.cfg.on("change", (ev: { key: string; kind: string }) => {
    if (ev.kind === "setting" && VOICE_SETTING_KEYS.has(ev.key)) {
      scheduleRestart(`setting changed: ${ev.key}`);
    } else if (ev.kind === "secret" && VOICE_VAULT_KEYS.has(ev.key)) {
      scheduleRestart(`vault key changed: ${ev.key}`);
    }
  });
  deps.cfg.vault.on("unlocked", () => scheduleRestart("vault unlocked"));

  // Spawn at boot so the worker is already warm when the user clicks
  // the mic — but only if the vault is unlocked. If it's locked the
  // worker would spawn with no API keys and crash the first time the
  // user speaks. In that case we wait for the first sidecar/start call
  // (which happens after the user has unlocked the vault to use chat).
  if (deps.cfg.vault.isUnlocked()) {
    void spawnVoiceWorker().catch((e) => {
      console.error(`[voice] initial worker spawn failed: ${(e as Error).message}`);
    });
  } else {
    console.log("[voice] worker spawn deferred — vault is locked");
  }

  // Manual restart endpoint — the UI can hit this after saving voice
  // settings if it wants the change applied before the next mic tap.
  app.post("/api/voice/worker/restart", async (_req: Request, res: Response) => {
    if (!deps.cfg.vault.isUnlocked()) {
      return res.status(423).json({ error: "Vault is locked" });
    }
    await restartVoiceWorker("manual");
    res.json({ ok: true });
  });

  app.post("/api/voice/sidecar/start", async (_req: Request, res: Response) => {
    if (!deps.cfg.vault.isUnlocked()) {
      return res.status(400).json({
        ok: false,
        error: "Vault is locked — unlock before starting voice.",
      });
    }
    respawnBlocked = false;
    try {
      await spawnVoiceWorker();
      res.json({
        ok: true,
        running: voiceWorkerProc !== null && !voiceWorkerProc.killed,
        pid: voiceWorkerProc?.pid ?? null,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: (e as Error).message });
    }
  });

  app.post("/api/voice/sidecar/stop", async (_req: Request, res: Response) => {
    respawnBlocked = true;
    if (voiceWorkerProc && !voiceWorkerProc.killed) {
      voiceWorkerProc.kill("SIGTERM");
      voiceWorkerProc = null;
    }
    res.json({ ok: true, running: false });
  });

  app.get("/api/voice/sidecar/status", (_req: Request, res: Response) => {
    const running = voiceWorkerProc !== null && !voiceWorkerProc.killed && voiceWorkerProc.exitCode === null;
    res.json({ running, pid: voiceWorkerProc?.pid ?? null });
  });

  // ── Wake word (requires Python sidecar — not available in pure TS mode) ──
  app.post("/api/voice/wake/start", async (_req: Request, res: Response) => {
    // Wake word detection uses OpenWakeWord (Python) — start voice worker instead
    res.json({ ok: true, message: "Wake word starts the voice worker. Use the mic button." });
  });

  app.post("/api/voice/wake/stop", async (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.get("/api/voice/wake/status", async (_req: Request, res: Response) => {
    const running = voiceWorkerProc !== null && !voiceWorkerProc.killed && voiceWorkerProc.exitCode === null;
    res.json({ running });
  });

  app.post("/api/voice/wake-event", (_req: Request, res: Response) => {
    deps.audit.log("watcher_trigger", "wake-word", "Wake word detected");
    res.json({ ok: true });
  });

  // ── Dynamic voice providers — live-discovered from each provider's API.
  //
  // Delegates to the same discovery layer the LLM selector uses (see
  // src/models/discovery.ts + /api/providers). This route exists as a
  // voice-scoped shim so the Settings UI only gets providers that
  // actually do STT/TTS, without a manual filter pass.
  app.get("/api/voice/providers", async (_req: Request, res: Response) => {
    const { PROVIDER_CATALOG } = await import("../../models/providers.js");
    const { discoverVoiceCatalog } = await import("../../models/discovery.js");

    const sttProviders: { id: string; name: string; configured: boolean; models: { id: string; name: string }[] }[] = [];
    const ttsProviders: { id: string; name: string; configured: boolean; models: { id: string; name: string }[]; voices: { id: string; name: string; gender?: string }[] }[] = [];
    const imageProviders: { id: string; name: string; configured: boolean; models: { id: string; name: string }[] }[] = [];
    const videoProviders: { id: string; name: string; configured: boolean; models: { id: string; name: string }[] }[] = [];

    await Promise.all(PROVIDER_CATALOG.map(async (p) => {
      const doesStt = p.capabilities.includes("stt");
      const doesTts = p.capabilities.includes("tts");
      const doesImage = p.capabilities.includes("image");
      const doesVideo = p.capabilities.includes("video");
      if (!doesStt && !doesTts && !doesImage && !doesVideo) return;

      const configured = p.secretKey
        ? deps.cfg.vault.isUnlocked() && deps.cfg.vault.has(p.secretKey)
        : true;
      const apiKey = configured && p.secretKey
        ? deps.cfg.vault.get(p.secretKey)?.reveal()
        : undefined;
      const baseUrl = p.baseUrlSetting
        ? ((deps.cfg.settings.getGeneric(p.baseUrlSetting) as string | undefined) ?? p.defaultBaseUrl)
        : p.defaultBaseUrl;

      const live = (doesStt || doesTts) && configured
        ? await discoverVoiceCatalog(p.id, apiKey, baseUrl)
        : { sttModels: [], ttsModels: [], ttsVoices: [] };

      const sttModels = live.sttModels.length > 0
        ? live.sttModels
        : (p.sttModels ?? []).map((m) => ({ id: m.id, name: m.name }));
      const ttsModels = live.ttsModels.length > 0
        ? live.ttsModels
        : (p.ttsModels ?? []).map((m) => ({ id: m.id, name: m.name }));
      const ttsVoices = live.ttsVoices.length > 0
        ? live.ttsVoices
        : (p.ttsVoices ?? []).map((v) => ({ id: v.id, name: v.name }));
      const imageModels = (p.imageModels ?? []).map((m) => ({ id: m.id, name: m.name }));
      const videoModels = (p.videoModels ?? []).map((m) => ({ id: m.id, name: m.name }));

      if (doesStt) {
        sttProviders.push({ id: p.id, name: p.name, configured, models: sttModels });
      }
      if (doesTts) {
        ttsProviders.push({ id: p.id, name: p.name, configured, models: ttsModels, voices: ttsVoices });
      }
      if (doesImage) {
        imageProviders.push({ id: p.id, name: p.name, configured, models: imageModels });
      }
      if (doesVideo) {
        videoProviders.push({ id: p.id, name: p.name, configured, models: videoModels });
      }
    }));

    const current = {
      stt: (deps.cfg.settings.getGeneric("DAEMORA_STT_PROVIDER") as string) ?? null,
      tts: (deps.cfg.settings.getGeneric("DAEMORA_TTS_PROVIDER") as string) ?? null,
      ttsVoice: (deps.cfg.settings.getGeneric("TTS_VOICE") as string) ?? null,
      ttsModel: (deps.cfg.settings.getGeneric("TTS_MODEL") as string) ?? null,
      sttModel: (deps.cfg.settings.getGeneric("STT_MODEL") as string) ?? null,
      imageModel: deps.cfg.setting("IMAGE_GEN_MODEL") ?? null,
      videoModel: deps.cfg.setting("VIDEO_GEN_MODEL") ?? null,
    };

    res.json({ stt: sttProviders, tts: ttsProviders, image: imageProviders, video: videoProviders, current });
  });

  // ── Voices list (legacy compat)
  app.get("/api/voices", async (_req: Request, res: Response) => {
    const { PROVIDER_CATALOG } = await import("../../models/providers.js");
    const voices: { provider: string; voices: { id: string; name: string }[] }[] = [];
    for (const p of PROVIDER_CATALOG) {
      if (p.ttsVoices && p.ttsVoices.length > 0) {
        voices.push({ provider: p.id, voices: [...p.ttsVoices] });
      }
    }
    res.json({ voices });
  });
}

