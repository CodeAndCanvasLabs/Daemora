/**
 * GroqTTS — a native Groq TTS plugin for the LiveKit voice pipeline.
 *
 * Background: the @livekit/agents-plugin-openai TTS class hardcodes
 * `response_format: "pcm"` when it calls the upstream API. That works
 * for OpenAI's real TTS endpoint, but Groq's OpenAI-compatible
 * `/v1/audio/speech` endpoint rejects it — it only accepts `wav`. So
 * every Groq TTS call via the openai plugin fails with a 400:
 *
 *   "response_format must be one of [wav]"
 *
 * This class talks to Groq directly with `response_format=wav`, strips
 * the 44-byte WAV header, then feeds the raw PCM16 LE payload into
 * `AudioByteStream` the same way the openai plugin would. Output sample
 * rate is reported to LiveKit at construction time and must match the
 * actual WAV rate; if Groq ever returns something else we fall back to
 * the header-reported rate.
 */

import { type APIConnectOptions, AudioByteStream, tts } from "@livekit/agents";

/**
 * Default per-model sample rates. Groq's `/v1/audio/speech` returns
 * WAV at different rates depending on the model — PlayAI is 48 kHz,
 * Orpheus is 24 kHz. If LiveKit is told the wrong rate, playback runs
 * at the wrong speed (24 kHz played as 48 kHz = double-speed chipmunk).
 */
const SAMPLE_RATE_BY_MODEL: Record<string, number> = {
  "playai-tts": 48_000,
  "playai-tts-english": 48_000,
  "playai-tts-arabic": 48_000,
  "canopylabs/orpheus-v1-english": 24_000,
  "orpheus-v1-english": 24_000,
};
const DEFAULT_SAMPLE_RATE = 24_000;
const CHANNELS = 1;
const WAV_HEADER_BYTES = 44;

/**
 * Default voice per Groq TTS model. Groq rejects requests without a voice
 * with `400 voice is required`, and the right voice depends on the model
 * family (PlayAI uses "Fritz-PlayAI" / "Celeste-PlayAI" / etc., Orpheus
 * uses "tara" / "leah" / etc.). Picking the wrong family also 400s, so a
 * single global default isn't safe — match by model.
 */
const DEFAULT_VOICE_BY_MODEL: Record<string, string> = {
  "playai-tts": "Fritz-PlayAI",
  "playai-tts-english": "Fritz-PlayAI",
  "playai-tts-arabic": "Ahmad-PlayAI",
  // Groq Orpheus accepts only [autumn, diana, hannah, austin, daniel, troy]
  // — older "tara" / "leah" names from upstream Orpheus are rejected
  // (400 invalid_request_error). Picking `troy` as a neutral male voice;
  // override per-deploy via TTS_VOICE setting.
  "canopylabs/orpheus-v1-english": "troy",
  "orpheus-v1-english": "troy",
};
const FALLBACK_VOICE = "Fritz-PlayAI";

/** Voices Groq's Orpheus model currently accepts. Used to validate TTS_VOICE. */
const ORPHEUS_VOICES = new Set(["autumn", "diana", "hannah", "austin", "daniel", "troy"]);

export function defaultVoiceForGroqModel(model: string): string {
  return DEFAULT_VOICE_BY_MODEL[model] ?? FALLBACK_VOICE;
}

export interface GroqTTSOpts {
  readonly apiKey: string;
  readonly model: string;
  readonly voice: string;
  readonly baseURL?: string;
  /** Override the inferred sample rate. Defaults look up the model. */
  readonly sampleRate?: number;
}

export class GroqTTS extends tts.TTS {
  label = "groq.TTS";

  private readonly opts: Required<Omit<GroqTTSOpts, "sampleRate">> & { sampleRate: number };

  constructor(opts: GroqTTSOpts) {
    const rate = opts.sampleRate ?? SAMPLE_RATE_BY_MODEL[opts.model] ?? DEFAULT_SAMPLE_RATE;
    super(rate, CHANNELS, { streaming: false });
    // Hard-fall back to a model-appropriate voice if none was passed —
    // Groq returns `400 voice is required` and PlayAI/Orpheus voices are
    // not interchangeable, so we have to pick one matched to the model.
    // Also validate Orpheus voices: the upstream "tara"/"leah" names are
    // rejected by Groq, so silently substitute the default if the user
    // supplied one that's not in the accepted list.
    let voice = (opts.voice && opts.voice.trim() !== "")
      ? opts.voice.toLowerCase()
      : defaultVoiceForGroqModel(opts.model);
    if (/orpheus/.test(opts.model) && !ORPHEUS_VOICES.has(voice)) {
      voice = defaultVoiceForGroqModel(opts.model);
    }
    this.opts = {
      baseURL: "https://api.groq.com/openai/v1",
      ...opts,
      voice,
      sampleRate: rate,
    };
  }

  override get model(): string {
    return this.opts.model;
  }

  override get provider(): string {
    return "groq";
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): tts.ChunkedStream {
    const audioPromise = fetchWavAsPcm(this.opts, text, abortSignal);
    return new GroqChunkedStream(
      this,
      text,
      audioPromise,
      this.opts.sampleRate,
      connOptions,
      abortSignal,
    );
  }

  stream(): tts.SynthesizeStream {
    throw new Error("GroqTTS does not support streaming synthesis");
  }
}

class GroqChunkedStream extends tts.ChunkedStream {
  label = "groq.ChunkedStream";
  private readonly pcmPromise: Promise<ArrayBuffer>;
  private readonly sampleRate: number;

  constructor(
    ttsRef: GroqTTS,
    text: string,
    pcmPromise: Promise<ArrayBuffer>,
    sampleRate: number,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, ttsRef, connOptions, abortSignal);
    this.pcmPromise = pcmPromise;
    this.sampleRate = sampleRate;
  }

  protected override async run(): Promise<void> {
    const requestId = randomId();
    const stream = new AudioByteStream(this.sampleRate, CHANNELS);
    const queue = (this as unknown as { queue: { put: (v: unknown) => void; close: () => void } }).queue;

    // Pre-emit ~120 ms of silence BEFORE awaiting the WAV. Groq's
    // `/audio/speech` is non-streaming and Orpheus often takes 6-12 s
    // to return; LiveKit's voice pipeline aborts the speak if no
    // first frame arrives within 10 s, which is why daemora went
    // silent for non-trivial responses. PCM16 silence = zeros at the
    // configured sample rate; LiveKit emits it inaudibly while we
    // wait for real audio.
    const silenceMs = 120;
    const silenceBytes = new ArrayBuffer(Math.floor((this.sampleRate * silenceMs) / 1000) * 2);
    for (const f of stream.write(silenceBytes)) {
      queue.put({ requestId, segmentId: "0", frame: f, final: false });
    }

    try {
      const pcm = await this.pcmPromise;
      const frames = stream.write(pcm);
      let last: (typeof frames)[number] | undefined;
      const emit = (segmentId: string, final: boolean) => {
        if (!last) return;
        queue.put({ requestId, segmentId, frame: last, final });
        last = undefined;
      };
      for (const frame of frames) {
        emit("0", false);
        last = frame;
      }
      emit("0", true);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      throw err;
    } finally {
      queue.close();
    }
  }
}

async function fetchWavAsPcm(
  opts: Required<GroqTTSOpts>,
  text: string,
  abortSignal?: AbortSignal,
): Promise<ArrayBuffer> {
  // Pre-flight checks so misconfigurations turn into clear messages
  // rather than an opaque "Groq TTS 400" trace from the API.
  if (!opts.apiKey) {
    throw new Error("Groq TTS: GROQ_API_KEY is not set. Add it in Settings → Secrets.");
  }
  if (!opts.voice) {
    throw new Error(
      `Groq TTS: no voice configured for model "${opts.model}". ` +
      `Set TTS_VOICE in Settings → Voice (e.g. "Fritz-PlayAI" for PlayAI models, "tara" for Orpheus).`,
    );
  }
  if (!opts.model) {
    throw new Error("Groq TTS: no model configured. Set TTS_MODEL in Settings → Voice.");
  }

  const resp = await fetch(`${opts.baseURL}/audio/speech`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: text,
      model: opts.model,
      voice: opts.voice,
      response_format: "wav",
    }),
    ...(abortSignal ? { signal: abortSignal } : {}),
  });
  if (!resp.ok) {
    const body = await resp.text();
    // Surface the Groq error message verbatim — it's already informative
    // ("voice is required", "model not found", etc.) and the worker logs
    // it through the normal error pipeline.
    throw new Error(`Groq TTS ${resp.status}: ${body.slice(0, 200)}`);
  }
  const buf = await resp.arrayBuffer();
  // Strip WAV header. PCM16 LE starts at byte 44 for a standard 16-bit WAV.
  // If the header is a different length (e.g. contains LIST chunks), search
  // for the "data" marker instead.
  return stripWavHeader(buf);
}

function stripWavHeader(buf: ArrayBuffer): ArrayBuffer {
  const view = new DataView(buf);
  // Look for "data" (0x64 0x61 0x74 0x61) chunk marker within the first
  // 128 bytes; its length is the 4 bytes following.
  for (let i = 12; i < Math.min(buf.byteLength - 8, 256); i++) {
    if (
      view.getUint8(i) === 0x64 &&
      view.getUint8(i + 1) === 0x61 &&
      view.getUint8(i + 2) === 0x74 &&
      view.getUint8(i + 3) === 0x61
    ) {
      return buf.slice(i + 8);
    }
  }
  // Fall back to the standard header length.
  return buf.slice(WAV_HEADER_BYTES);
}

function randomId(): string {
  return Math.random().toString(36).slice(2);
}
