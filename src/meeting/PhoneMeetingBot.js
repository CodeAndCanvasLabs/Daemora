/**
 * PhoneMeetingBot - joins meetings by dialing the meeting's phone number via Twilio.
 *
 * Every meeting platform (Google Meet, Zoom, Teams) provides a dial-in number + PIN.
 * This bot calls that number using Twilio, then:
 *   - Plays the PIN via DTMF
 *   - Starts OpenAI Realtime STT (mu-law → transcription, server-side VAD)
 *   - Generates LLM responses → ElevenLabs/OpenAI TTS → mu-law → injects into call
 *   - Returns full transcript when call ends
 *
 * Pipeline (same as OpenClaw voice-call):
 *   Twilio WebSocket ← mu-law → RealtimeSTT → LLM → TelephonyTTS → mu-law → Twilio WebSocket
 */

import twilio from "twilio";
import { configStore } from "../config/ConfigStore.js";
import { RealtimeSTT } from "../voice/RealtimeSTT.js";
import { synthesizeForTelephony } from "../voice/TelephonyTTS.js";
import { getStream } from "../voice/MediaStreamHandler.js";
import { updateState, addTranscript, cleanup, getSession, _getRawSession as _getRawSessionSync } from "./MeetingSessionManager.js";

function conf(key) {
  return process.env[key] || configStore.get(key) || "";
}

// session token → PhoneMeetingSession
const _sessions = new Map();

class PhoneMeetingSession {
  constructor(sessionId, opts) {
    this.sessionId = sessionId;
    this.dialIn = opts.dialIn;
    this.pin = opts.pin || "";
    this.displayName = opts.displayName || "Daemora";
    this.callSid = null;
    this.stream = null;
    this.stt = null;
    this._ended = false;
    this._endResolve = null;
    this._lastSpeechTime = 0;
    this._lastRespondedAt = 0;
    this._isSpeaking = false;
    this._llmModel = conf("MEETING_LLM") || conf("DEFAULT_MODEL") || "openai:gpt-4o-mini";
  }

  // Called when Twilio WebSocket stream connects
  attachStream(stream) {
    this.stream = stream;

    // Receive inbound audio → send to STT
    stream.onAudio = (mulawChunk) => {
      if (this.stt && !this._isSpeaking) {
        this.stt.sendAudio(mulawChunk);
      }
    };

    stream.onStop = () => this._onCallEnded();
  }

  startSTT() {
    const apiKey = conf("OPENAI_API_KEY");
    if (!apiKey) {
      console.log("[PhoneMeeting] No OPENAI_API_KEY - STT disabled, listen-only");
      return;
    }

    this.stt = new RealtimeSTT({
      apiKey,
      onSpeechStart: () => {
        // Barge-in: cancel current TTS if user starts speaking
        if (this.stream && this._isSpeaking) {
          this.stream.clearQueue();
          this._isSpeaking = false;
        }
      },
      onPartial: (text) => {
        // Real-time partial transcript (not added to final transcript)
      },
      onTranscript: (text) => {
        this._lastSpeechTime = Date.now();
        addTranscript(this.sessionId, { speaker: "participant", text });
        console.log(`[PhoneMeeting:${this.sessionId}] Heard: "${text.slice(0, 80)}"`);
        // Trigger response
        this._respond(text).catch(e => console.log(`[PhoneMeeting] respond error: ${e.message}`));
      },
      onError: (e) => console.log(`[PhoneMeeting] STT error: ${e.message}`),
    });

    this.stt.connect().catch(e => console.log(`[PhoneMeeting] STT connect failed: ${e.message}`));
  }

  async _respond(userText) {
    if (this._isSpeaking || this._ended) return;

    const llm = _resolveLLM(this._llmModel);
    if (!llm.apiKey) {
      console.log("[PhoneMeeting] No LLM key - cannot respond");
      return;
    }

    // Build conversation context from transcript
    const session = { transcript: [] }; // will be populated by MeetingSessionManager
    const context = _buildContext(this.sessionId);

    this._isSpeaking = true;
    this._lastRespondedAt = Date.now();

    try {
      const r = await fetch(`${llm.baseURL}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${llm.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: llm.model,
          messages: [
            { role: "system", content: _buildSystemPrompt(this.displayName) },
            { role: "user", content: `Meeting transcript:\n${context}\n\nRespond naturally in 1-2 sentences, or reply with "" to stay silent.` },
          ],
          max_completion_tokens: 100,
          temperature: 0.7,
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!r.ok) { this._isSpeaking = false; return; }

      const data = await r.json();
      const text = data.choices?.[0]?.message?.content?.replace(/^["']|["']$/g, "").trim();
      if (!text || text === "") { this._isSpeaking = false; return; }

      // TTS → mu-law → Twilio
      const mulawBuf = await synthesizeForTelephony(text, {
        voiceId: conf("TTS_VOICE") || undefined,
      });

      addTranscript(this.sessionId, { speaker: this.displayName, text });
      console.log(`[PhoneMeeting:${this.sessionId}] Speaking: "${text.slice(0, 80)}"`);

      if (this.stream && !this._ended) {
        await this.stream.queueAudio(mulawBuf);
      }
    } catch (e) {
      console.log(`[PhoneMeeting] respond error: ${e.message}`);
    } finally {
      this._isSpeaking = false;
    }
  }

  async speak(text) {
    if (!text || this._ended) return "Not in meeting or already ended";
    if (this._isSpeaking) return "Currently speaking";

    this._isSpeaking = true;
    try {
      const mulawBuf = await synthesizeForTelephony(text, {
        voiceId: conf("TTS_VOICE") || undefined,
      });
      addTranscript(this.sessionId, { speaker: this.displayName, text });
      if (this.stream) await this.stream.queueAudio(mulawBuf);
      return `Spoke: "${text.slice(0, 80)}"`;
    } catch (e) {
      return `Speak error: ${e.message}`;
    } finally {
      this._isSpeaking = false;
    }
  }

  // Block until call ends, then return transcript
  waitForEnd(timeoutMs = 4 * 60 * 60 * 1000) {
    if (this._ended) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this._endResolve = resolve;
      setTimeout(() => reject(new Error("Meeting timeout (4h)")), timeoutMs);
    });
  }

  _onCallEnded() {
    if (this._ended) return;
    this._ended = true;
    console.log(`[PhoneMeeting:${this.sessionId}] Call ended`);

    if (this.stt) { this.stt.close(); this.stt = null; }
    try { updateState(this.sessionId, "left"); } catch {}
    cleanup(this.sessionId);

    if (this._endResolve) {
      this._endResolve();
      this._endResolve = null;
    }
  }

  end() {
    this._onCallEnded();
    _sessions.delete(this.sessionId);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Dial into a meeting via Twilio.
 * @param {string} sessionId
 * @param {object} opts
 * @param {string} opts.dialIn - Meeting dial-in phone number (E.164)
 * @param {string} [opts.pin] - Meeting PIN (digits only)
 * @param {string} [opts.displayName]
 * @returns {Promise<{status, sessionId, callSid}>}
 */
export async function joinMeeting(sessionId, opts) {
  const { dialIn, pin, displayName } = opts;
  if (!dialIn) throw new Error("dialIn phone number is required");

  const accountSid = conf("TWILIO_ACCOUNT_SID");
  const authToken = conf("TWILIO_AUTH_TOKEN");
  const fromNumber = conf("TWILIO_PHONE_FROM");
  const publicUrl = conf("DAEMORA_PUBLIC_URL") || conf("SERVER_URL");

  if (!accountSid || !authToken) throw new Error("TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN required");
  if (!fromNumber) throw new Error("TWILIO_PHONE_FROM required");
  if (!publicUrl) throw new Error("DAEMORA_PUBLIC_URL required (e.g. https://your-server.com) for Twilio webhooks");

  const session = new PhoneMeetingSession(sessionId, { dialIn, pin, displayName });
  _sessions.set(sessionId, session);

  // TwiML webhook: Twilio calls this when the outbound call connects
  // It returns <Connect><Stream> to open the WebSocket media stream
  const webhookUrl = `${publicUrl}/voice/meeting/answer/${sessionId}`;
  const statusUrl = `${publicUrl}/voice/meeting/status/${sessionId}`;

  const client = twilio(accountSid, authToken);
  const call = await client.calls.create({
    to: dialIn,
    from: fromNumber,
    url: webhookUrl,
    statusCallback: statusUrl,
    statusCallbackMethod: "POST",
    statusCallbackEvent: ["completed", "failed", "busy", "no-answer"],
  });

  session.callSid = call.sid;
  console.log(`[PhoneMeeting:${sessionId}] Outbound call initiated: ${call.sid} → ${dialIn}`);

  return { status: "joining", sessionId, callSid: call.sid };
}

/**
 * Attach a Twilio WebSocket stream to a session.
 * Called by the webhook handler when Twilio opens the stream.
 */
export function attachStream(sessionId, stream) {
  const session = _sessions.get(sessionId);
  if (!session) return;
  session.attachStream(stream);
  session.startSTT();
  updateState(sessionId, "active");
  console.log(`[PhoneMeeting:${sessionId}] Stream attached - STT active`);
}

/**
 * Speak text in the meeting.
 */
export async function speakInMeeting(sessionId, text) {
  const session = _sessions.get(sessionId);
  if (!session) return "Session not found";
  return session.speak(text);
}

/**
 * Leave the meeting.
 */
export async function leaveMeeting(sessionId) {
  const session = _sessions.get(sessionId);
  if (!session) return "Session not found";

  const accountSid = conf("TWILIO_ACCOUNT_SID");
  const authToken = conf("TWILIO_AUTH_TOKEN");

  // Hang up via Twilio REST API
  if (session.callSid && accountSid && authToken) {
    try {
      const client = twilio(accountSid, authToken);
      await client.calls(session.callSid).update({ status: "completed" });
    } catch (e) {
      console.log(`[PhoneMeeting:${sessionId}] Hangup error: ${e.message}`);
    }
  }

  session.end();
  return "Left meeting";
}

/**
 * Block until meeting ends, then return full transcript.
 */
export async function waitForMeetingEnd(sessionId) {
  const session = _sessions.get(sessionId);
  if (!session) return { status: "meeting_ended", transcript: "Session not found" };

  try { await session.waitForEnd(); } catch {}

  // Get full transcript from MeetingSessionManager
  const s = getSession(sessionId);
  const transcript = s?.transcript || [];
  const formatted = transcript.map(e => {
    const time = new Date(e.timestamp).toISOString().slice(11, 19);
    return `[${time}] ${e.speaker}: ${e.text}`;
  }).join("\n") || "No transcript entries.";

  _sessions.delete(sessionId);
  return { status: "meeting_ended", transcript: formatted };
}

// ── LLM routing ───────────────────────────────────────────────────────────────

function _resolveLLM(modelStr) {
  const [provider, ...rest] = (modelStr || "openai:gpt-4o-mini").split(":");
  const model = rest.join(":") || "gpt-4o-mini";
  const map = {
    openai:     { base: conf("OPENAI_BASE_URL") || "https://api.openai.com/v1",       key: conf("OPENAI_API_KEY") },
    anthropic:  { base: "https://api.anthropic.com/v1",                               key: conf("ANTHROPIC_API_KEY") },
    groq:       { base: "https://api.groq.com/openai/v1",                             key: conf("GROQ_API_KEY") },
    xai:        { base: "https://api.x.ai/v1",                                        key: conf("XAI_API_KEY") },
    deepseek:   { base: "https://api.deepseek.com/v1",                                key: conf("DEEPSEEK_API_KEY") },
    openrouter: { base: "https://openrouter.ai/api/v1",                               key: conf("OPENROUTER_API_KEY") },
    ollama:     { base: conf("OLLAMA_BASE_URL") || "http://localhost:11434/v1",        key: "ollama" },
  };
  const c = map[provider] || map.openai;
  return { provider, model, baseURL: c.base, apiKey: c.key };
}

function _buildContext(sessionId) {
  try {
    const s = _getRawSessionSync(sessionId);
    if (!s) return "";
    return s.transcript.slice(-20).map(e => `[${e.speaker}]: ${e.text}`).join("\n");
  } catch { return ""; }
}

function _buildSystemPrompt(botName) {
  return `You are ${botName} - an AI participant in a live phone meeting. Be concise, natural, human.
- 1-2 sentences max. Answer directly.
- NEVER start with "I'm here to help". Just answer.
- If the conversation doesn't need you → respond with "" (empty string).
- Match the energy: casual → casual, technical → direct.`;
}
