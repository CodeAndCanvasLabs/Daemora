/**
 * VoiceWebhook — Express router for Twilio voice call webhooks.
 *
 * Twilio calls these endpoints during the lifecycle of an active call:
 *
 *   POST /voice/answer/:sessionId    — call connected, return opening TwiML
 *   POST /voice/input/:sessionId     — caller finished speaking (SpeechResult)
 *   POST /voice/wait/:sessionId      — poll for agent's next reply
 *   POST /voice/status/:sessionId    — call status change (completed/failed/busy)
 *
 * The agent talks to the call via VoiceSessionManager (not via these routes).
 * These routes are only for Twilio ↔ Daemora signalling.
 */

import { Router } from "express";
import voiceSessionManager from "./VoiceSessionManager.js";

const router = Router();

// Twilio sends form-encoded bodies — parse them for voice routes
import { urlencoded } from "express";
router.use(urlencoded({ extended: false }));

// ─── Helpers ──────────────────────────────────────────────────────────────────

// ── Voice quality + latency config ────────────────────────────────────────────
// Polly.Joanna = Amazon Polly neural voice via Twilio — high quality, low latency.
// Use "alice" as fallback (built-in Twilio TTS, slightly lower quality but zero extra cost).
const VOICE    = process.env.VOICE_TTS_VOICE    || "Polly.Joanna";
const LANGUAGE = process.env.VOICE_TTS_LANGUAGE || "en-US";

// How long Twilio waits for the caller to start speaking (seconds).
// 4s is fast enough to feel responsive; increase if callers complain of being cut off.
const SPEECH_TIMEOUT_START = process.env.VOICE_SPEECH_TIMEOUT || "4";

// How long Twilio waits after caller stops speaking before finalising (seconds).
// "auto" = Twilio's ML-based end-of-speech detector — fastest + most accurate option.
const SPEECH_TIMEOUT_END   = "auto";

// How often we poll for the agent's reply while the caller is on hold (ms).
// Lower = snappier response, but more HTTP round-trips. 500ms is a good balance.
const POLL_PAUSE_MS = parseInt(process.env.VOICE_POLL_INTERVAL_MS || "500", 10);
const POLL_PAUSE_S  = Math.max(1, Math.round(POLL_PAUSE_MS / 1000)); // TwiML needs whole seconds
// ──────────────────────────────────────────────────────────────────────────────

function twiml(content) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${content}</Response>`;
}

function escapeXml(str) {
  return (str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sayAndListen(sessionId, message) {
  // <Gather> wraps <Say> so caller can barge-in (interrupt the agent mid-sentence).
  // speechTimeout="auto" uses Twilio's ML end-of-speech — much faster than a fixed delay.
  // bargeIn="true" lets the caller speak while agent is still talking (reduces turn latency).
  return twiml(
    `<Gather input="speech" timeout="${SPEECH_TIMEOUT_START}" speechTimeout="${SPEECH_TIMEOUT_END}" ` +
    `bargeIn="true" action="/voice/input/${sessionId}" method="POST">` +
    `<Say voice="${VOICE}" language="${LANGUAGE}">${escapeXml(message)}</Say>` +
    `</Gather>` +
    // Fallback if no speech detected — re-poll the agent (in case it has a follow-up)
    `<Redirect method="POST">/voice/wait/${sessionId}</Redirect>`
  );
}

function waitAndPoll(sessionId) {
  // Hold music is better UX than silence but adds latency — skip it.
  // Use the shortest TwiML pause Twilio supports (1s) and redirect.
  // The actual responsiveness is determined by how fast the agent queues its reply
  // (session.waitForAgentResponse uses 8s internal timeout, which is polled at 500ms).
  return twiml(
    `<Pause length="${POLL_PAUSE_S}"/>` +
    `<Redirect method="POST">/voice/wait/${sessionId}</Redirect>`
  );
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * POST /voice/answer/:sessionId
 * Twilio hits this immediately when the outbound call is answered.
 * We mark the session connected and speak the greeting (if any).
 */
router.post("/answer/:sessionId", (req, res) => {
  const session = voiceSessionManager.get(req.params.sessionId);
  if (!session) {
    // Unknown session — hang up gracefully
    res.type("text/xml").send(twiml("<Hangup/>"));
    return;
  }

  session.markConnected();
  console.log(`[VoiceWebhook] Call answered for session ${session.id}`);

  const greeting = session.greeting || "Hello, this is your AI assistant. How can I help you?";
  res.type("text/xml").send(sayAndListen(session.id, greeting));
});

/**
 * POST /voice/input/:sessionId
 * Twilio posts the caller's transcribed speech here (SpeechResult field).
 * We store it in the session and redirect to /voice/wait while the agent thinks.
 */
router.post("/input/:sessionId", (req, res) => {
  const session = voiceSessionManager.get(req.params.sessionId);
  if (!session || session.status === "ended") {
    res.type("text/xml").send(twiml("<Hangup/>"));
    return;
  }

  const speechResult = req.body?.SpeechResult || "";
  const confidence   = req.body?.Confidence   || "?";

  if (speechResult.trim()) {
    console.log(`[VoiceWebhook] Caller spoke (confidence ${confidence}): "${speechResult}"`);
    session.receiveCallerInput(speechResult.trim());
  } else {
    console.log(`[VoiceWebhook] No speech detected — re-polling`);
  }

  // Park the call while the agent processes the input
  res.type("text/xml").send(waitAndPoll(session.id));
});

/**
 * POST /voice/wait/:sessionId
 * Polling endpoint. Agent queues its reply via session.setAgentResponse().
 * We wait up to 8s for a reply; if none, return pause+redirect (1-second loop).
 */
router.post("/wait/:sessionId", async (req, res) => {
  const session = voiceSessionManager.get(req.params.sessionId);
  if (!session || session.status === "ended") {
    res.type("text/xml").send(twiml("<Hangup/>"));
    return;
  }

  // Wait up to 8s for the agent to queue a reply
  await session.waitForAgentResponse(8_000);

  const response = session.consumeResponse();

  if (response === null) {
    // Agent still thinking — keep the caller on hold
    res.type("text/xml").send(waitAndPoll(session.id));
    return;
  }

  if (response === "__HANGUP__") {
    session.end();
    voiceSessionManager.delete(session.id);
    console.log(`[VoiceWebhook] Session ${session.id} ended by agent`);
    res.type("text/xml").send(twiml("<Say>Goodbye.</Say><Hangup/>"));
    return;
  }

  // Agent reply — speak it and listen for caller's next utterance
  res.type("text/xml").send(sayAndListen(session.id, response));
});

/**
 * POST /voice/status/:sessionId
 * Twilio status callback — tracks call lifecycle (ringing → in-progress → completed).
 * If call ends unexpectedly (caller hangs up), we clean up the session.
 */
router.post("/status/:sessionId", (req, res) => {
  const { CallStatus, CallSid } = req.body || {};
  const session = voiceSessionManager.get(req.params.sessionId);

  console.log(`[VoiceWebhook] Status callback: ${CallSid} → ${CallStatus}`);

  if (session && (CallStatus === "completed" || CallStatus === "failed" || CallStatus === "busy" || CallStatus === "no-answer")) {
    if (session.status !== "ended") {
      session.end();
      voiceSessionManager.delete(session.id);
      console.log(`[VoiceWebhook] Session ${session.id} closed via status callback (${CallStatus})`);
    }
  }

  res.status(204).end();
});

export default router;
