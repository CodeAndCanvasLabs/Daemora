/**
 * VoiceSession — state machine for a single voice conversation.
 *
 * Manages the full lifecycle: IDLE → CONNECTING → LISTENING → CAPTURING
 * → BUFFERING → THINKING → SPEAKING → back to LISTENING. Handles
 * interruptions, errors, reconnection, filler audio, and cleanup.
 *
 * One VoiceSession per WebSocket connection. The session owns its
 * STT adapter, TTS adapter, and agent interaction. Transport-agnostic:
 * receives PCM audio in, emits audio + control events out.
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

import { createLogger } from "../util/logger.js";
import { isHallucinatedTranscript } from "./transcriptFilter.js";

const log = createLogger("voice.session");

export type VoiceState =
  | "idle"
  | "connecting"
  | "listening"
  | "capturing"
  | "buffering"
  | "thinking"
  | "filler"
  | "speaking"
  | "confirming"
  | "cancelling"
  | "error"
  | "disconnected";

export interface VoiceSessionConfig {
  /** STT provider to use. */
  sttProvider: string;
  sttApiKey: string;
  /** TTS provider to use. */
  ttsProvider: string;
  ttsApiKey: string;
  ttsVoice?: string;
  ttsBaseURL?: string;
  ttsModel?: string;
  /** Function to process user text through the main agent. */
  processText: (text: string, sessionId: string) => Promise<AsyncIterable<string>>;
  /** Language hint for STT. */
  language?: string;
  /** Silence duration (ms) to detect end of speech. */
  endpointingMs?: number;
}

export interface VoiceSessionMetrics {
  readonly sessionId: string;
  readonly startedAt: number;
  endedAt: number | null;
  turns: number;
  totalUserSpeechMs: number;
  totalAgentSpeechMs: number;
  interruptions: number;
  toolCalls: number;
  errors: { type: string; count: number }[];
  latencies: number[]; // per-turn latency (user stop → first audio)
}

/**
 * Events emitted by VoiceSession:
 *   state       — { state, previousState }
 *   audio_out   — Buffer (audio chunk to send to client)
 *   transcript  — { text, interim, speaker: 'user' | 'agent' }
 *   tool        — { name, status: 'started' | 'completed' | 'error' }
 *   error       — Error
 *   metrics     — VoiceSessionMetrics (on disconnect)
 */
export class VoiceSession extends EventEmitter {
  readonly id: string;
  private _state: VoiceState = "idle";
  private readonly config: VoiceSessionConfig;
  private readonly metrics: VoiceSessionMetrics;

  // STT/TTS adapters — loaded dynamically based on config
  private stt: any = null;
  private tts: any = null;

  // Buffering
  private transcriptBuffer = "";
  private bufferTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly BUFFER_TIMEOUT_MS = 1200; // wait for more speech

  // Thinking timer (for filler audio)
  private thinkingTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly FILLER_DELAY_MS = 2000;

  // Silence timer (idle timeout)
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly SILENCE_PROMPT_MS = 120_000; // 2 min
  private readonly SILENCE_DISCONNECT_MS = 900_000; // 15 min

  // Turn tracking
  private turnStartedAt = 0;
  private speechStartedAt = 0;
  private agentSpeakingStartedAt = 0;

  // Interruption tracking
  private interruptionCount = 0;
  private lastInterruptionAt = 0;

  constructor(config: VoiceSessionConfig) {
    super();
    this.id = randomUUID();
    this.config = config;
    this.metrics = {
      sessionId: this.id,
      startedAt: Date.now(),
      endedAt: null,
      turns: 0,
      totalUserSpeechMs: 0,
      totalAgentSpeechMs: 0,
      interruptions: 0,
      toolCalls: 0,
      errors: [],
      latencies: [],
    };
  }

  get state(): VoiceState {
    return this._state;
  }

  private transition(newState: VoiceState): void {
    const prev = this._state;
    if (prev === newState) return;

    // Guard: can't transition from terminal state
    if (prev === "disconnected") return;

    log.info({ sessionId: this.id, from: prev, to: newState }, "voice state transition");
    this._state = newState;
    this.emit("state", { state: newState, previousState: prev });

    // State entry actions
    switch (newState) {
      case "listening":
        this.resetSilenceTimer();
        break;
      case "capturing":
        this.speechStartedAt = Date.now();
        this.clearSilenceTimer();
        break;
      case "thinking":
        this.turnStartedAt = Date.now();
        this.startThinkingTimer();
        break;
      case "speaking":
        this.agentSpeakingStartedAt = Date.now();
        this.clearThinkingTimer();
        break;
      case "cancelling":
        this.handleCancellation();
        break;
      case "disconnected":
        this.cleanup();
        break;
    }
  }

  // ── Public API ────────────────────────────────────────────────

  async connect(): Promise<void> {
    this.transition("connecting");

    try {
      // Load STT adapter dynamically
      this.stt = await this.createSTTAdapter();
      await this.stt.connect({
        apiKey: this.config.sttApiKey,
        language: this.config.language ?? "multi",
        sampleRate: 16000,
        encoding: "linear16",
        endpointingMs: this.config.endpointingMs ?? 300,
        interimResults: true,
      });

      // Wire STT events
      this.stt.on("speech_started", () => this.onSpeechStarted());
      this.stt.on("transcript", (ev: any) => this.onTranscript(ev));
      this.stt.on("utterance_end", () => this.onUtteranceEnd());
      this.stt.on("error", (err: Error) => this.onSTTError(err));
      this.stt.on("close", () => this.onSTTClose());

      // Load TTS adapter dynamically
      this.tts = await this.createTTSAdapter();
      await this.tts.connect({
        apiKey: this.config.ttsApiKey,
        voice: this.config.ttsVoice,
        model: this.config.ttsModel,
        baseURL: this.config.ttsBaseURL,
      });

      // Wire TTS events
      this.tts.on("audio", (chunk: Buffer) => this.onTTSAudio(chunk));
      this.tts.on("flushed", () => this.onTTSFlushed());
      this.tts.on("error", (err: Error) => this.onTTSError(err));

      this.transition("listening");
      log.info({ sessionId: this.id }, "voice session connected");
    } catch (e) {
      log.error({ sessionId: this.id, err: (e as Error).message }, "voice session connect failed");
      this.transition("error");
      throw e;
    }
  }

  /** Receive audio from client. Muted during SPEAKING to prevent echo. */
  receiveAudio(pcm16: Buffer): void {
    if (this._state === "disconnected" || this._state === "idle") return;
    // Don't send to STT while agent is speaking — prevents echo feedback loop
    if (this._state === "speaking" || this._state === "filler" || this._state === "thinking") return;
    // Server-side energy gate: Whisper hallucinates "Thank you" on
    // silence. Drop frames whose RMS energy is below a conservative
    // threshold (~noise floor) so the STT never has to decide what
    // silence "means".
    if (isBelowNoiseFloor(pcm16)) return;
    this.stt?.sendAudio(pcm16);
  }

  /** Disconnect and cleanup. */
  disconnect(): void {
    this.transition("disconnected");
  }

  // ── STT Event Handlers ────────────────────────────────────────

  private onSpeechStarted(): void {
    if (this._state === "listening") {
      this.transition("capturing");
    } else if (this._state === "speaking" || this._state === "filler") {
      // Ignore speech detection in first 2s of speaking — prevents echo/noise false positives
      if (this.agentSpeakingStartedAt && Date.now() - this.agentSpeakingStartedAt < 2000) {
        return; // Too early — probably echo from speakers, not real interruption
      }

      // User interrupted the agent
      this.metrics.interruptions++;
      this.interruptionCount++;
      this.lastInterruptionAt = Date.now();

      // If rapid interruptions, don't react yet
      if (this.interruptionCount >= 3 && Date.now() - this.lastInterruptionAt < 10_000) {
        log.info({ sessionId: this.id }, "rapid interruptions detected, extending endpointing");
      }

      this.transition("cancelling");
    }
  }

  private onTranscript(ev: { text: string; isFinal: boolean; confidence: number; speechFinal: boolean }): void {
    if (!ev.text.trim()) return;

    // Emit interim transcript for UI display
    this.emit("transcript", {
      text: ev.text,
      interim: !ev.isFinal,
      speaker: "user",
    });

    if (ev.speechFinal || ev.isFinal) {
      // User finished a phrase
      this.transcriptBuffer += (this.transcriptBuffer ? " " : "") + ev.text.trim();

      if (this._state === "capturing") {
        this.transition("buffering");
        this.startBufferTimer();
      } else if (this._state === "buffering") {
        // More speech arrived — reset buffer timer
        this.resetBufferTimer();
      }
    }
  }

  private onUtteranceEnd(): void {
    if (this._state === "buffering" || this._state === "capturing") {
      this.clearBufferTimer();
      this.processTranscript();
    }
  }

  private onSTTError(err: Error): void {
    log.error({ sessionId: this.id, err: err.message }, "STT error");
    this.recordError("stt_error");
    // Don't transition to error — STT adapter handles reconnection
  }

  private onSTTClose(): void {
    log.warn({ sessionId: this.id }, "STT connection closed");
    // Adapter handles reconnection
  }

  // ── TTS Event Handlers ────────────────────────────────────────

  private onTTSAudio(chunk: Buffer): void {
    if (this._state === "cancelling" || this._state === "disconnected") return;

    if (this._state === "thinking" || this._state === "filler") {
      this.transition("speaking");
    }

    this.emit("audio_out", chunk);
  }

  private onTTSFlushed(): void {
    if (this._state === "speaking") {
      // Agent finished speaking
      const speakDuration = Date.now() - this.agentSpeakingStartedAt;
      this.metrics.totalAgentSpeechMs += speakDuration;
      this.transition("listening");
    }
  }

  private onTTSError(err: Error): void {
    log.error({ sessionId: this.id, err: err.message }, "TTS error");
    this.recordError("tts_error");
  }

  // ── Transcript Processing ─────────────────────────────────────

  private async processTranscript(): Promise<void> {
    const text = this.transcriptBuffer.trim();
    this.transcriptBuffer = "";

    // Noise rejection: too short
    if (text.length < 2 || text.split(/\s+/).length < 1) {
      this.transition("listening");
      return;
    }

    // Reject known STT hallucinations ("Thank you.", "Thanks for
    // watching", ".", etc.) — these are Whisper training artifacts that
    // appear whenever the decoder is fed silence or low-energy audio.
    if (isHallucinatedTranscript(text)) {
      log.debug({ sessionId: this.id, text }, "voice: dropping hallucinated transcript");
      this.transition("listening");
      return;
    }

    // Track user speech duration
    if (this.speechStartedAt) {
      this.metrics.totalUserSpeechMs += Date.now() - this.speechStartedAt;
    }

    this.metrics.turns++;
    this.transition("thinking");

    try {
      // Send to Daemora's AgentLoop
      const tokenStream = await this.config.processText(text, `voice:${this.id}`);

      let sentenceBuffer = "";
      let firstTokenAt = 0;

      for await (const token of tokenStream) {
        if (!firstTokenAt) {
          firstTokenAt = Date.now();
          const latency = firstTokenAt - this.turnStartedAt;
          this.metrics.latencies.push(latency);
        }

        // If cancelled during processing, stop
        if (this._state === "cancelling" || this._state === "disconnected") break;

        sentenceBuffer += token;

        // Emit agent transcript for UI
        this.emit("transcript", { text: token, interim: true, speaker: "agent" });

        // Sentence boundary detection — flush to TTS
        if (this.isSentenceBoundary(sentenceBuffer)) {
          this.tts?.sendText(sentenceBuffer);
          sentenceBuffer = "";
        }
      }

      // Flush remaining text
      if (sentenceBuffer.trim() && this._state !== "cancelling") {
        this.tts?.sendText(sentenceBuffer);
      }
      this.tts?.flush();

    } catch (e) {
      log.error({ sessionId: this.id, err: (e as Error).message }, "agent processing error");
      this.recordError("agent_error");
      // Speak error message
      this.tts?.sendText("Sorry, I ran into an issue. Can you try again?");
      this.tts?.flush();
    }
  }

  // ── Interruption ──────────────────────────────────────────────

  private handleCancellation(): void {
    // Stop TTS
    this.tts?.cancel();

    // Tell client to stop playing audio
    this.emit("stop_playback");

    // Clear thinking timer
    this.clearThinkingTimer();

    // Back to listening
    setTimeout(() => {
      if (this._state === "cancelling") {
        this.transition("listening");
      }
    }, 100);
  }

  // ── Timers ────────────────────────────────────────────────────

  private startBufferTimer(): void {
    this.clearBufferTimer();
    this.bufferTimer = setTimeout(() => {
      if (this._state === "buffering") {
        this.processTranscript();
      }
    }, this.BUFFER_TIMEOUT_MS);
  }

  private resetBufferTimer(): void {
    this.startBufferTimer();
  }

  private clearBufferTimer(): void {
    if (this.bufferTimer) {
      clearTimeout(this.bufferTimer);
      this.bufferTimer = null;
    }
  }

  private startThinkingTimer(): void {
    this.clearThinkingTimer();
    this.thinkingTimer = setTimeout(() => {
      if (this._state === "thinking") {
        this.transition("filler");
        // Play pre-cached filler: "Hmm, let me think..."
        this.emit("filler", "thinking");
      }
    }, this.FILLER_DELAY_MS);
  }

  private clearThinkingTimer(): void {
    if (this.thinkingTimer) {
      clearTimeout(this.thinkingTimer);
      this.thinkingTimer = null;
    }
  }

  private resetSilenceTimer(): void {
    this.clearSilenceTimer();
    this.silenceTimer = setTimeout(() => {
      if (this._state === "listening") {
        // Prompt after 2 min silence
        this.tts?.sendText("I'm still here if you need anything.");
        this.tts?.flush();
      }
    }, this.SILENCE_PROMPT_MS);
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  // ── Utilities ─────────────────────────────────────────────────

  private isSentenceBoundary(text: string): boolean {
    const trimmed = text.trim();
    // Sentence-ending punctuation
    if (/[.!?]\s*$/.test(trimmed)) return true;
    // Comma with enough accumulated text
    if (/,\s*$/.test(trimmed) && trimmed.split(/\s+/).length >= 5) return true;
    // Long text without punctuation — force flush
    if (trimmed.length >= 80) return true;
    return false;
  }

  private recordError(type: string): void {
    const existing = this.metrics.errors.find((e) => e.type === type);
    if (existing) existing.count++;
    else this.metrics.errors.push({ type, count: 1 });
  }

  private async createSTTAdapter(): Promise<any> {
    switch (this.config.sttProvider) {
      case "deepgram": {
        const { DeepgramSTT } = await import("./stt/DeepgramSTT.js");
        return new DeepgramSTT();
      }
      case "groq": {
        const { GroqSTT } = await import("./stt/GroqSTT.js");
        return new GroqSTT();
      }
      default: {
        // Try deepgram as default
        const { DeepgramSTT } = await import("./stt/DeepgramSTT.js");
        return new DeepgramSTT();
      }
    }
  }

  private async createTTSAdapter(): Promise<any> {
    const p = this.config.ttsProvider;
    if (p === "elevenlabs") {
      const { ElevenLabsTTS } = await import("./tts/ElevenLabsTTS.js");
      return new ElevenLabsTTS();
    }
    if (p === "cartesia") {
      const { CartesiaTTS } = await import("./tts/CartesiaTTS.js");
      return new CartesiaTTS();
    }
    // OpenAI, Groq, and any OpenAI-compatible → OpenAITTS
    const { OpenAITTS } = await import("./tts/OpenAITTS.js");
    return new OpenAITTS();
  }

  private cleanup(): void {
    this.clearBufferTimer();
    this.clearThinkingTimer();
    this.clearSilenceTimer();
    this.stt?.disconnect().catch(() => {});
    this.tts?.disconnect().catch(() => {});
    this.metrics.endedAt = Date.now();
    this.emit("metrics", this.metrics);
    log.info({ sessionId: this.id, metrics: this.metrics }, "voice session ended");
  }
}

/**
 * Server-side noise-floor gate. Drops frames whose RMS energy is clearly
 * in the analog noise-floor range (≈ -60 dBFS on a 32767 peak). Anything
 * louder — including quiet and whispered speech — passes through so the
 * STT can do its job. The post-transcript hallucination filter catches
 * anything that still slips through.
 */
const NOISE_FLOOR_RMS = 60;
function isBelowNoiseFloor(pcm16: Buffer): boolean {
  if (pcm16.length < 2) return true;
  const samples = pcm16.length / 2;
  let sumSq = 0;
  for (let i = 0; i < pcm16.length; i += 2) {
    const v = pcm16.readInt16LE(i);
    sumSq += v * v;
  }
  const rms = Math.sqrt(sumSq / samples);
  return rms < NOISE_FLOOR_RMS;
}
