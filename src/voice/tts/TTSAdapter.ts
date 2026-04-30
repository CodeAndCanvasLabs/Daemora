/**
 * TTSAdapter — provider-agnostic text-to-speech interface.
 *
 * All TTS providers (streaming WebSocket or HTTP) extend this class
 * and emit a uniform set of events for the voice pipeline.
 */

import { EventEmitter } from "node:events";

// ── Config ──────────────────────────────────────────────────────────

export interface TTSConfig {
  apiKey: string;
  voice?: string;
  model?: string;
  outputFormat?: "pcm16" | "mp3" | "opus";
  sampleRate?: number;
  /** Override base URL for OpenAI-compatible APIs (e.g. Groq). */
  baseURL?: string;
}

// ── Audio format descriptor ─────────────────────────────────────────

export interface AudioFormat {
  encoding: "pcm16" | "mp3" | "opus";
  sampleRate: number;
  channels: number;
}

// ── Type-safe event map ─────────────────────────────────────────────

export interface TTSEvents {
  audio: [chunk: Buffer, format: AudioFormat];
  flushed: [];
  error: [error: Error];
  close: [code?: number, reason?: string];
}

// ── Abstract base ───────────────────────────────────────────────────

export abstract class TTSAdapter extends EventEmitter {
  abstract readonly id: string;
  abstract readonly streaming: boolean;

  constructor() {
    super();
    // Prevent unhandled error events from crashing the process
    this.on("error", () => {});
  }

  /** Connect to the provider and prepare for synthesis. */
  abstract connect(config: TTSConfig): Promise<void>;

  /** Gracefully disconnect and release resources. */
  abstract disconnect(): Promise<void>;

  /** Feed text (or a token) into the synthesiser. */
  abstract sendText(text: string): void;

  /** Signal end of text input — provider should finish generating. */
  abstract flush(): void;

  /** Cancel current synthesis (e.g. user interrupted). */
  abstract cancel(): void;

  // ── Typed emit / on helpers ─────────────────────────────────────

  override emit<K extends keyof TTSEvents>(event: K, ...args: TTSEvents[K]): boolean {
    return super.emit(event as string, ...args);
  }

  override on<K extends keyof TTSEvents>(event: K, listener: (...args: TTSEvents[K]) => void): this {
    return super.on(event as string, listener as (...args: unknown[]) => void);
  }

  override once<K extends keyof TTSEvents>(event: K, listener: (...args: TTSEvents[K]) => void): this {
    return super.once(event as string, listener as (...args: unknown[]) => void);
  }
}
