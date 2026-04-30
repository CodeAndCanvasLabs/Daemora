/**
 * STTAdapter — provider-agnostic speech-to-text interface.
 *
 * All STT providers (streaming or batch) extend this class and emit
 * a uniform set of events so the voice pipeline can swap providers
 * without changing any upstream logic.
 */

import { EventEmitter } from "node:events";

// ── Config ──────────────────────────────────────────────────────────

export interface STTConfig {
  apiKey: string;
  language?: string;
  sampleRate?: number;
  encoding?: string;
  /** Silence duration (ms) to detect end of speech. */
  endpointingMs?: number;
  interimResults?: boolean;
}

// ── Events ──────────────────────────────────────────────────────────

export interface TranscriptEvent {
  text: string;
  isFinal: boolean;
  confidence: number;
  /** true = user finished speaking (endpointing triggered). */
  speechFinal: boolean;
}

// ── Type-safe event map ─────────────────────────────────────────────

export interface STTEvents {
  transcript: [event: TranscriptEvent];
  speech_started: [];
  speech_ended: [];
  utterance_end: [];
  error: [error: Error];
  close: [code?: number, reason?: string];
}

// ── Abstract base ───────────────────────────────────────────────────

export abstract class STTAdapter extends EventEmitter {
  abstract readonly id: string;
  abstract readonly streaming: boolean;

  constructor() {
    super();
    // Prevent unhandled error events from crashing the process
    this.on("error", () => {});
  }

  /** Connect to the provider and prepare for audio. */
  abstract connect(config: STTConfig): Promise<void>;

  /** Gracefully disconnect and release resources. */
  abstract disconnect(): Promise<void>;

  /** Feed raw PCM16 LE audio into the recogniser. */
  abstract sendAudio(pcm16: Buffer): void;

  // ── Typed emit / on helpers ─────────────────────────────────────

  override emit<K extends keyof STTEvents>(event: K, ...args: STTEvents[K]): boolean {
    return super.emit(event as string, ...args);
  }

  override on<K extends keyof STTEvents>(event: K, listener: (...args: STTEvents[K]) => void): this {
    return super.on(event as string, listener as (...args: unknown[]) => void);
  }

  override once<K extends keyof STTEvents>(event: K, listener: (...args: STTEvents[K]) => void): this {
    return super.once(event as string, listener as (...args: unknown[]) => void);
  }
}
