/**
 * VoiceAgent — LiveKit worker process for Daemora voice.
 *
 * This file is the entry point for the child worker process that LiveKit
 * spawns whenever a user joins a voice room. It:
 *
 *   1. Loads Silero VAD and LiveKit's multilingual turn detector.
 *   2. Instantiates STT / TTS plugins from the provider chosen in
 *      Settings (forwarded to the worker via env vars by
 *      /api/voice/sidecar/start).
 *   3. Instantiates DaemoraLLM — our bridge that streams responses
 *      from the main process's /api/chat over SSE so voice turns run
 *      through Daemora's AgentLoop (with all its tools, memory, and
 *      session history), not LiveKit's built-in LLM.
 *   4. Starts an `AgentSession` and joins the room.
 *
 * The LLM is Daemora. STT, TTS, VAD, audio I/O, barge-in, and turn
 * detection are LiveKit's — that's exactly what the JS version used
 * and what this port is supposed to reproduce.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  defineAgent,
  voice,
} from "@livekit/agents";
import * as silero from "@livekit/agents-plugin-silero";
import type { stt as sttNs, tts as ttsNs } from "@livekit/agents";

import { DaemoraLLM } from "./DaemoraLLM.js";

// SOUL.md provides the agent's voice personality — shared with text chat.
let SOUL_PROMPT: string;
try {
  SOUL_PROMPT = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../SOUL.md"), "utf-8").trim();
} catch {
  SOUL_PROMPT = "You are Daemora — a personal AI agent. Be warm, natural, and helpful.";
}

// Catch top-level unhandled rejections so a TTS/STT misconfiguration
// (e.g. "Groq TTS 400: voice is required") logs a single clean error
// instead of spamming the parent's debug stream with a giant trace and
// taking the worker down on reconnect. Recoverable (TTS/STT) errors are
// flagged by their `recoverable: false` tag — we surface those to stderr
// in a parseable shape and keep the worker alive so the next mic tap
// can reconfigure and retry.
process.on("unhandledRejection", (reason) => {
  const err = reason as { error?: unknown; label?: string; type?: string };
  const inner = err?.error instanceof Error ? err.error.message : String(err?.error ?? reason);
  const label = err?.label ?? "voice";
  const type = err?.type ?? "unknown";
  console.error(`[voice] [${type}] ${label}: ${inner}`);
});

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },

  entry: async (ctx: JobContext) => {
    const daemoraUrl = process.env["DAEMORA_HTTP"] ?? "http://127.0.0.1:8081";

    const stt = await buildSTT();
    const tts = await buildTTS();
    const agentLlm = new DaemoraLLM({ daemoraUrl });

    const agent = new voice.Agent({
      instructions:
        SOUL_PROMPT +
        "\n\n## Voice Mode Active\nYou are speaking via voice right now. Keep responses short and natural — no markdown, no code blocks, no bullets. React with emotion.",
    });

    // NOTE: we intentionally skip `turnDetection`. LiveKit's multilingual
    // turn-detector forks a separate ONNX inference process; on macOS
    // that child regularly crashes (`libc++abi: mutex lock failed`),
    // leaving the parent with a dead IPC channel — every subsequent
    // `send()` throws `ERR_IPC_CHANNEL_CLOSED` and the whole session
    // hangs with no TTS reply. VAD alone detects end-of-speech well
    // enough for conversational voice; the refinement the turn detector
    // adds ("was that a pause or end-of-turn?") isn't worth the crash
    // exposure. Re-enable when we upgrade / patch @livekit/agents.
    const session = new voice.AgentSession({
      stt,
      llm: agentLlm,
      tts,
      vad: ctx.proc.userData.vad as silero.VAD,
      // Daemora's agent loop can take 20+ seconds for tool-heavy turns
      // (shell commands, file reads, web fetches). LiveKit's preemptive
      // generation fires TTS synthesis the moment a user transcript is
      // finalised and expects text to start flowing within ~10 s; if
      // none arrives it closes the stream as stalled. Disable it so
      // TTS only runs against a complete, in-hand response.
      preemptiveGeneration: false,
    });

    await session.start({
      agent,
      room: ctx.room,
      // Keep the agent alive when the user disconnects. Otherwise the
      // session closes → the worker tears down → rtc-node's C++
      // teardown hits its mutex bug and crashes → auto-respawn burns
      // ~25s before the worker is registered again, so a second mic
      // tap within that window never gets an agent.
      inputOptions: { closeOnDisconnect: false },
    });
    await ctx.connect();

    session.generateReply({
      instructions:
        "Greet the user warmly and naturally. You are Daemora. Be brief — one sentence, like a friend picking up the phone.",
    });
  },
});

// ── STT factory ──────────────────────────────────────────────────

async function buildSTT(): Promise<sttNs.STT> {
  // Same empty-string defence as buildTTS — see comment there.
  const provider = (process.env["DAEMORA_STT_PROVIDER"] || undefined) ?? inferDefaultStt();
  // Settings UI stores plain model ids ("whisper-large-v3-turbo") while the
  // voice route also forwards inference-gateway format ("groq/whisper-...").
  // The non-gateway plugins (OpenAI-compatible, Deepgram) want the plain id,
  // so strip any `provider/` prefix before handing it over.
  const modelRaw = process.env["STT_MODEL"] || process.env["DAEMORA_STT_MODEL"] || undefined;
  const model = stripProviderPrefix(modelRaw, provider);

  switch (provider) {
    case "deepgram": {
      const apiKey = process.env["DEEPGRAM_API_KEY"];
      if (!apiKey) throw new Error("DEEPGRAM_API_KEY not set");
      const { STT } = await import("@livekit/agents-plugin-deepgram");
      return new STT({
        apiKey,
        ...(model ? { model } : {}),
      } as ConstructorParameters<typeof STT>[0]);
    }
    case "elevenlabs": {
      // ElevenLabs Scribe — batch STT (no streaming). LiveKit wraps
      // it in StreamAdapter via VAD segmentation. Supports 99+
      // languages with auto-detect.
      const apiKey = process.env["ELEVENLABS_API_KEY"];
      if (!apiKey) throw new Error("ELEVENLABS_API_KEY not set");
      const language = process.env["STT_LANGUAGE"];
      const { ElevenLabsSTT } = await import("./ElevenLabsSTT.js");
      return new ElevenLabsSTT({
        apiKey,
        ...(model ? { model } : {}),
        ...(language ? { language } : {}),
      });
    }
    case "groq": {
      const apiKey = process.env["GROQ_API_KEY"];
      if (!apiKey) throw new Error("GROQ_API_KEY not set");
      const { STT } = await import("@livekit/agents-plugin-openai");
      return STT.withGroq({
        apiKey,
        ...(model ? { model } : {}),
      });
    }
    case "openai":
    default: {
      const apiKey = process.env["OPENAI_API_KEY"];
      if (!apiKey) throw new Error("OPENAI_API_KEY not set");
      const { STT } = await import("@livekit/agents-plugin-openai");
      return new STT({
        apiKey,
        ...(model ? { model } : { model: "whisper-1" }),
      });
    }
  }
}

// ── TTS factory ──────────────────────────────────────────────────

async function buildTTS(): Promise<ttsNs.TTS> {
  // Empty-string defence: settings often round-trip as "" instead of
  // undefined. Treat empty as unset so the per-provider defaults below
  // (e.g. Groq → "Fritz-PlayAI", OpenAI → "nova") actually kick in.
  const provider = (process.env["DAEMORA_TTS_PROVIDER"] || undefined) ?? inferDefaultTts();
  const modelRaw = process.env["TTS_MODEL"] || process.env["DAEMORA_TTS_MODEL"] || undefined;
  const model = stripProviderPrefix(modelRaw, provider);
  const voice = process.env["TTS_VOICE"] || process.env["DAEMORA_TTS_VOICE"] || undefined;

  switch (provider) {
    case "cartesia": {
      const apiKey = process.env["CARTESIA_API_KEY"];
      if (!apiKey) throw new Error("CARTESIA_API_KEY not set");
      const { TTS } = await import("@livekit/agents-plugin-cartesia");
      return new TTS({
        apiKey,
        ...(model ? { model } : {}),
        ...(voice ? { voice } : {}),
      } as ConstructorParameters<typeof TTS>[0]);
    }
    case "elevenlabs": {
      // ElevenLabs exposes 8 TTS models (eleven_flash_v2_5 / v3 /
      // multilingual_v2 / turbo_v2_5 / …) and supports 29–32 languages
      // depending on model. `voice` is the voiceId (UUID) — ElevenLabs
      // doesn't accept friendly names on the TTS endpoint.
      const apiKey = process.env["ELEVENLABS_API_KEY"];
      if (!apiKey) throw new Error("ELEVENLABS_API_KEY not set");
      const language = process.env["TTS_LANGUAGE"] ?? process.env["DAEMORA_TTS_LANGUAGE"];
      const { TTS } = await import("@livekit/agents-plugin-elevenlabs");
      return new TTS({
        apiKey,
        ...(model ? { model } : { model: "eleven_turbo_v2_5" }),
        ...(voice ? { voiceId: voice } : {}),
        ...(language ? { language } : {}),
      } as ConstructorParameters<typeof TTS>[0]);
    }
    case "groq": {
      // Groq's /v1/audio/speech endpoint rejects response_format=pcm
      // (the OpenAI plugin's hardcoded default) — it only accepts wav.
      // Use our dedicated GroqTTS which requests wav and strips the
      // WAV header to PCM16 before feeding it into LiveKit's frame
      // pipeline.
      const apiKey = process.env["GROQ_API_KEY"];
      if (!apiKey) throw new Error("GROQ_API_KEY not set");
      // Groq deprecated `playai-tts` on 2025-12-23; the current Groq TTS
      // model is `canopylabs/orpheus-v1-english` (Orpheus). Default voice
      // must be one of [autumn, diana, hannah, austin, daniel, troy] —
      // anything else 400s.
      const { GroqTTS } = await import("./GroqTTS.js");
      return new GroqTTS({
        apiKey,
        model: model ?? "canopylabs/orpheus-v1-english",
        voice: voice ?? "troy",
      });
    }
    case "openai":
    default: {
      const apiKey = process.env["OPENAI_API_KEY"];
      if (!apiKey) throw new Error("OPENAI_API_KEY not set");
      const { TTS } = await import("@livekit/agents-plugin-openai");
      return new TTS({
        apiKey,
        ...(model ? { model } : { model: "gpt-4o-mini-tts" }),
        ...(voice ? { voice: voice as never } : { voice: "nova" as never }),
      });
    }
  }
}

function stripProviderPrefix(model: string | undefined, provider: string): string | undefined {
  if (!model) return undefined;
  // Strip "groq/", "openai/", etc. — inference-gateway format isn't
  // valid against the plain provider API.
  const prefix = `${provider}/`;
  if (model.toLowerCase().startsWith(prefix)) return model.slice(prefix.length);
  // Also strip colon variant ("groq:whisper-..."), just in case.
  const colonPrefix = `${provider}:`;
  if (model.toLowerCase().startsWith(colonPrefix)) return model.slice(colonPrefix.length);
  return model;
}

function inferDefaultStt(): string {
  if (process.env["DEEPGRAM_API_KEY"]) return "deepgram";
  if (process.env["GROQ_API_KEY"]) return "groq";
  return "openai";
}
function inferDefaultTts(): string {
  if (process.env["CARTESIA_API_KEY"]) return "cartesia";
  if (process.env["ELEVENLABS_API_KEY"]) return "elevenlabs";
  if (process.env["GROQ_API_KEY"]) return "groq";
  return "openai";
}

// Explicit agentName — the server pairs this name with the dispatch
// created in /api/voice/token. Without it the worker relies on
// "automatic dispatch" which only fires for rooms created AFTER the
// worker is registered, causing races on the first click.
cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: "daemora",
  }),
);
