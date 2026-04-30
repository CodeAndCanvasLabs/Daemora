/**
 * ElevenLabsSTT — ElevenLabs "Scribe" speech-to-text via REST.
 *
 * The @livekit/agents-plugin-elevenlabs package only ships TTS, so we
 * wrap Scribe ourselves. Scribe is a batch endpoint (no streaming),
 * which means we declare `streaming: false` and rely on LiveKit's
 * built-in StreamAdapter to segment incoming audio with VAD and call
 * `_recognize` per utterance.
 *
 * Docs: https://elevenlabs.io/docs/api-reference/speech-to-text
 *
 * Supported languages: 99+ (model auto-detects; can be forced via
 * `language`). Model id is `scribe_v1` (and faster `scribe_v1_experimental`
 * variants — configurable per request).
 */

import { type AudioBuffer, stt, mergeFrames } from "@livekit/agents";

export interface ElevenLabsSTTOpts {
  readonly apiKey: string;
  /** Defaults to `scribe_v1`. */
  readonly model?: string;
  /**
   * Optional language hint. Omit to let Scribe auto-detect — useful
   * when the user switches languages mid-session.
   */
  readonly language?: string;
  readonly baseURL?: string;
  /** Return word-level timestamps. */
  readonly timestamps?: boolean;
  /** Diarise speakers (costs extra). */
  readonly diarize?: boolean;
}

export class ElevenLabsSTT extends stt.STT {
  label = "elevenlabs.STT";
  private readonly opts: Required<Pick<ElevenLabsSTTOpts, "apiKey" | "model" | "baseURL">> &
    Omit<ElevenLabsSTTOpts, "apiKey" | "model" | "baseURL">;

  constructor(opts: ElevenLabsSTTOpts) {
    super({ streaming: false, interimResults: false });
    this.opts = {
      model: "scribe_v1",
      baseURL: "https://api.elevenlabs.io/v1",
      ...opts,
    };
  }

  override get model(): string {
    return this.opts.model;
  }

  override get provider(): string {
    return "elevenlabs";
  }

  protected override async _recognize(
    buffer: AudioBuffer,
    abortSignal?: AbortSignal,
  ): Promise<stt.SpeechEvent> {
    const frame = mergeFrames(buffer);
    const wav = createWavBuffer(frame);

    const form = new FormData();
    form.set("model_id", this.opts.model);
    form.set(
      "file",
      new File([new Uint8Array(wav)], "audio.wav", { type: "audio/wav" }),
    );
    if (this.opts.language) form.set("language_code", this.opts.language);
    if (this.opts.timestamps) form.set("timestamps_granularity", "word");
    if (this.opts.diarize) form.set("diarize", "true");

    const resp = await fetch(`${this.opts.baseURL}/speech-to-text`, {
      method: "POST",
      headers: { "xi-api-key": this.opts.apiKey },
      body: form,
      ...(abortSignal ? { signal: abortSignal } : {}),
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`ElevenLabs STT ${resp.status}: ${body.slice(0, 200)}`);
    }
    const data = (await resp.json()) as {
      text?: string;
      language_code?: string;
    };

    return {
      type: stt.SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [
        {
          text: data.text ?? "",
          language: (data.language_code ?? this.opts.language ?? "") as unknown as stt.SpeechData["language"],
          startTime: 0,
          endTime: 0,
          confidence: 0,
        },
      ],
    };
  }

  override stream(): stt.SpeechStream {
    throw new Error("ElevenLabs STT does not support streaming — use StreamAdapter");
  }
}

/**
 * Pack a raw PCM16 mono `AudioFrame` into a minimal WAV buffer. Must
 * match the layout ElevenLabs expects when you upload `audio.wav`.
 */
function createWavBuffer(frame: import("@livekit/rtc-node").AudioFrame): Buffer {
  const bitsPerSample = 16;
  const byteRate = (frame.sampleRate * frame.channels * bitsPerSample) / 8;
  const blockAlign = (frame.channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + frame.data.byteLength, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(frame.channels, 22);
  header.writeUInt32LE(frame.sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(frame.data.byteLength, 40);
  return Buffer.concat([header, Buffer.from(frame.data.buffer)]);
}
