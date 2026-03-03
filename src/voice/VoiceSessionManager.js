/**
 * VoiceSessionManager — in-memory state for active interactive voice calls.
 *
 * Each session bridges two async tracks:
 *   - The agent loop (calls listen/speak/end as tool calls)
 *   - Twilio webhooks (hits /voice/input when caller speaks, /voice/wait to fetch agent reply)
 *
 * Promise-based signalling lets the agent's `listen` call block cleanly until
 * the caller speaks, without polling.
 */

import { randomBytes } from "node:crypto";

const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // prune sessions older than 2 hours

class VoiceSession {
  constructor({ sessionId, callSid, greeting }) {
    this.id = sessionId;
    this.callSid = callSid;
    this.status = "ringing";       // ringing | in-progress | ended
    this.greeting = greeting || null;
    this.transcript = [];          // [{ role: "caller"|"agent", text, timestamp }]
    this.createdAt = Date.now();
    this.endedAt = null;

    // Pending response the agent queued (text | "__HANGUP__" | null)
    this._pendingResponse = null;

    // Resolvers for agent's `listen` wait
    this._callerInputResolve = null;
    this._callerInputReject = null;

    // Resolve for the webhook's `wait` poll (so it knows a response is ready)
    this._responseReadyResolve = null;
  }

  /** Called by /voice/answer once Twilio dials and connects */
  markConnected() {
    this.status = "in-progress";
  }

  /** Called by /voice/input when Twilio STT delivers caller speech */
  receiveCallerInput(text) {
    const entry = { role: "caller", text, timestamp: new Date().toISOString() };
    this.transcript.push(entry);
    console.log(`[VoiceSession:${this.id}] Caller said: "${text}"`);

    if (this._callerInputResolve) {
      this._callerInputResolve(text);
      this._callerInputResolve = null;
      this._callerInputReject = null;
    }
  }

  /** Called by the agent's speak/end tool action */
  setAgentResponse(textOrSignal) {
    this._pendingResponse = textOrSignal;

    if (textOrSignal !== "__HANGUP__") {
      this.transcript.push({ role: "agent", text: textOrSignal, timestamp: new Date().toISOString() });
    }

    // Wake up the /voice/wait poll immediately
    if (this._responseReadyResolve) {
      this._responseReadyResolve();
      this._responseReadyResolve = null;
    }

    console.log(`[VoiceSession:${this.id}] Agent queued: "${textOrSignal}"`);
  }

  /**
   * Agent tool `listen` calls this — blocks until caller speaks or timeout.
   * @returns {Promise<string>} caller's spoken text
   */
  waitForCallerInput(timeoutMs = 120_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._callerInputResolve = null;
        this._callerInputReject = null;
        reject(new Error("Timed out waiting for caller input (caller may have hung up)"));
      }, timeoutMs);

      this._callerInputResolve = (text) => { clearTimeout(timer); resolve(text); };
      this._callerInputReject = (err) => { clearTimeout(timer); reject(err); };
    });
  }

  /**
   * /voice/wait calls this to block until the agent queues a reply.
   * Twilio expects a response quickly so we use a short timeout (8s) and fall
   * back to a <Pause>+<Redirect> loop when the agent hasn't responded yet.
   */
  waitForAgentResponse(timeoutMs = 8_000) {
    if (this._pendingResponse !== null) {
      return Promise.resolve(); // already ready
    }
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs); // resolve (don't reject) on timeout
      this._responseReadyResolve = () => { clearTimeout(timer); resolve(); };
    });
  }

  /** Consume and return the pending response, clearing it */
  consumeResponse() {
    const r = this._pendingResponse;
    this._pendingResponse = null;
    return r;
  }

  /** Mark session as ended */
  end() {
    this.status = "ended";
    this.endedAt = Date.now();
    // Reject any waiting agent listen call so it doesn't hang forever
    if (this._callerInputReject) {
      this._callerInputReject(new Error("Call ended"));
      this._callerInputResolve = null;
      this._callerInputReject = null;
    }
  }
}

// ─── Manager (singleton) ───────────────────────────────────────────────────────

class VoiceSessionManager {
  constructor() {
    this.sessions = new Map(); // sessionId → VoiceSession
    // Prune dead sessions every 30 minutes
    setInterval(() => this._prune(), 30 * 60 * 1000);
  }

  create({ callSid, greeting } = {}) {
    const sessionId = "vc_" + randomBytes(6).toString("hex");
    const session = new VoiceSession({ sessionId, callSid, greeting });
    this.sessions.set(sessionId, session);
    console.log(`[VoiceSessionManager] Created session ${sessionId} for call ${callSid}`);
    return session;
  }

  get(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  /** Look up session by Twilio call SID (used by status callbacks) */
  getBySid(callSid) {
    for (const session of this.sessions.values()) {
      if (session.callSid === callSid) return session;
    }
    return null;
  }

  delete(sessionId) {
    this.sessions.delete(sessionId);
  }

  _prune() {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.createdAt > SESSION_TTL_MS) {
        console.log(`[VoiceSessionManager] Pruning expired session ${id}`);
        session.end();
        this.sessions.delete(id);
      }
    }
  }
}

const voiceSessionManager = new VoiceSessionManager();
export default voiceSessionManager;
