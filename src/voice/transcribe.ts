/**
 * transcribeAudioFile — shared Whisper transcription helper.
 *
 * Used by:
 *   - The `transcribe_audio` tool (agent-exposed).
 *   - Channel integrations that need to turn inbound voice messages
 *     into text before handing them to the agent loop (Telegram voice,
 *     WhatsApp voice notes, iMessage audio, etc.).
 *
 * Prefers Groq Whisper (free tier, fast) and falls back to OpenAI.
 * Throws ProviderUnavailableError when neither key is set so callers
 * can decide whether to retry, notify the user, or skip the message.
 */

import { createReadStream } from "node:fs";
import { basename } from "node:path";

import type { ConfigManager } from "../config/ConfigManager.js";
import { ProviderError, ProviderUnavailableError } from "../util/errors.js";

export interface TranscribeOptions {
  /** ISO 639-1 hint (e.g. "en"). Optional — Whisper auto-detects. */
  readonly language?: string;
  /** Short context phrase that biases recognition (names, jargon). */
  readonly prompt?: string;
  /** Override the per-provider default model. */
  readonly model?: string;
  /** Hard timeout. Defaults to 60 s — enough for ~10 min of audio. */
  readonly timeoutMs?: number;
  /** Abort from upstream (e.g. channel stop). */
  readonly signal?: AbortSignal;
}

export interface TranscribeResult {
  readonly text: string;
  readonly provider: "groq" | "openai";
  readonly model: string;
}

export async function transcribeAudioFile(
  cfg: ConfigManager,
  filePath: string,
  opts: TranscribeOptions = {},
): Promise<TranscribeResult> {
  const groqKey = cfg.vault.get("GROQ_API_KEY")?.reveal();
  const openaiKey = cfg.vault.get("OPENAI_API_KEY")?.reveal();
  if (!groqKey && !openaiKey) {
    throw new ProviderUnavailableError("Whisper STT", "GROQ_API_KEY or OPENAI_API_KEY");
  }

  const isGroq = !!groqKey;
  const apiKey = isGroq ? groqKey! : openaiKey!;
  const baseUrl = isGroq ? "https://api.groq.com/openai/v1" : "https://api.openai.com/v1";
  const model = opts.model ?? (isGroq ? "whisper-large-v3-turbo" : "whisper-1");

  const form = new FormData();
  const stream = createReadStream(filePath);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  form.append("file", new Blob([Buffer.concat(chunks)]), basename(filePath));
  form.append("model", model);
  if (opts.prompt) form.append("prompt", opts.prompt);
  if (opts.language) form.append("language", opts.language);

  const timeoutSignal = AbortSignal.timeout(opts.timeoutMs ?? 60_000);
  const signal = opts.signal
    ? composeSignals([opts.signal, timeoutSignal])
    : timeoutSignal;

  const res = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ProviderError(
      `Whisper ${res.status}: ${body.slice(0, 400)}`,
      isGroq ? "groq" : "openai",
    );
  }
  const data = (await res.json()) as { text?: string };
  return {
    text: (data.text ?? "").trim(),
    provider: isGroq ? "groq" : "openai",
    model,
  };
}

function composeSignals(signals: readonly AbortSignal[]): AbortSignal {
  const native = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof native === "function") return native(Array.from(signals));
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) { ctrl.abort(s.reason); break; }
    s.addEventListener("abort", () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}
