/**
 * makeVoiceCall - Interactive outbound voice calls via Twilio REST API.
 *
 * Supports two modes:
 *
 *   ONE-SHOT: initiate a call that plays a message and hangs up
 *     makeVoiceCall("call", "+1555...", {"message":"Your order is ready"})
 *
 *   INTERACTIVE: full two-way conversation — agent speaks, listens, responds
 *     makeVoiceCall("initiate", "+1555...", {"greeting":"Hi, how can I help?"})
 *     makeVoiceCall("listen",   sessionId)                   ← blocks until caller speaks
 *     makeVoiceCall("speak",    sessionId, {"message":"..."}) ← agent says something
 *     makeVoiceCall("end",      sessionId)                   ← hang up
 *
 * Credential resolution order (first match wins):
 *   1. Per-tenant channel config  (daemora tenant channel set <id> twilio_account_sid ...)
 *   2. Global .env                (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_FROM)
 *
 * Required env for interactive mode:
 *   VOICE_WEBHOOK_BASE_URL=https://your-public-url.com  (Twilio must reach this URL)
 */

import tenantContext from "../tenants/TenantContext.js";
import voiceSessionManager from "../voice/VoiceSessionManager.js";

const TWILIO_API = "https://api.twilio.com/2010-04-01";

/** Resolve Twilio credentials: tenant config first, then global env */
function _getCreds() {
  const store = tenantContext.getStore();
  const ch = store?.resolvedConfig?.channelConfig || {};

  return {
    accountSid: ch.twilio_account_sid || process.env.TWILIO_ACCOUNT_SID || null,
    authToken:  ch.twilio_auth_token  || process.env.TWILIO_AUTH_TOKEN  || null,
    fromNumber: ch.twilio_phone_from  || process.env.TWILIO_PHONE_FROM  || null,
  };
}

/** Make an authenticated Twilio REST request */
async function _twilioRequest(accountSid, authToken, method, path, body = null) {
  const url = `${TWILIO_API}/Accounts/${accountSid}${path}`;
  const headers = {
    Authorization: "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64"),
    Accept: "application/json",
  };
  const opts = { method, headers };

  if (body) {
    opts.headers["Content-Type"] = "application/x-www-form-urlencoded";
    opts.body = new URLSearchParams(body).toString();
  }

  const res = await fetch(url, opts);
  const text = await res.text();
  try {
    return { ok: res.ok, status: res.status, data: JSON.parse(text) };
  } catch {
    return { ok: res.ok, status: res.status, data: { message: text } };
  }
}

/** Build simple one-shot TwiML (speak a message, hang up) */
function _buildSayTwiML(message, voice = "Polly.Joanna", language = "en-US") {
  const escaped = message
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="${voice}" language="${language}">${escaped}</Say></Response>`;
}

// ─── Main tool function ────────────────────────────────────────────────────────

export async function makeVoiceCall(params) {
  const action = params?.action;
  const phoneNumberOrSessionId = params?.target;
  // Merge flat fields with legacy options JSON for backward compat
  const _optStr = params?.options;
  const _legacy = _optStr ? (typeof _optStr === "string" ? JSON.parse(_optStr) : _optStr) : {};
  const { options: _discard, action: _a, target: _t, ...flatFields } = params || {};
  const _mergedOpts = { ..._legacy, ...flatFields };
  if (!action) return 'Error: action required. Use: initiate|listen|speak|end|status|list  (or "call" for one-shot)';

  const { accountSid, authToken, fromNumber } = _getCreds();

  // ── Non-Twilio session actions (don't need credentials) ─────────────────────
  // listen / speak / end operate on an existing session

  if (action === "listen") {
    const sessionId = phoneNumberOrSessionId;
    if (!sessionId) return "Error: provide the session ID returned by initiate.";
    const session = voiceSessionManager.get(sessionId);
    if (!session) return `Error: No active session "${sessionId}". Did the call end?`;
    if (session.status === "ended") return "Call has already ended.";

    const timeout = (_mergedOpts.timeout || 120) * 1000;

    try {
      const text = await session.waitForCallerInput(timeout);
      return `Caller said: "${text}"`;
    } catch (err) {
      return `${err.message}`;
    }
  }

  if (action === "speak") {
    const sessionId = phoneNumberOrSessionId;
    if (!sessionId) return "Error: provide the session ID returned by initiate.";
    const session = voiceSessionManager.get(sessionId);
    if (!session) return `Error: No active session "${sessionId}".`;
    if (session.status === "ended") return "Call has already ended.";

    const message = _mergedOpts.message;
    if (!message) return 'Error: message param is required for speak.';

    session.setAgentResponse(message);
    return `Speaking to caller: "${message}"`;
  }

  if (action === "end") {
    const sessionId = phoneNumberOrSessionId;
    if (!sessionId) return "Error: provide the session ID returned by initiate.";
    const session = voiceSessionManager.get(sessionId);
    if (!session) return `Error: No active session "${sessionId}".`;

    session.setAgentResponse("__HANGUP__");
    return `Ending call for session ${sessionId}.`;
  }

  if (action === "status") {
    const sessionId = phoneNumberOrSessionId;
    const session = voiceSessionManager.get(sessionId);
    if (!session) return `No active session "${sessionId}".`;

    const turns = session.transcript.length;
    const lastEntry = session.transcript[turns - 1];
    const lastTurn = lastEntry ? ` | Last: [${lastEntry.role}] "${lastEntry.text.slice(0, 60)}"` : "";
    return `Session ${session.id} | Status: ${session.status} | Turns: ${turns}${lastTurn}`;
  }

  // ── Twilio API actions — credentials required ────────────────────────────────

  if (!accountSid || !authToken) {
    return "Error: Twilio not configured. Set TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN in .env, or: daemora tenant channel set <id> twilio_account_sid <sid>";
  }

  const opts = _mergedOpts;

  // ── initiate — start an interactive call ────────────────────────────────────
  if (action === "initiate") {
    const to = phoneNumberOrSessionId;
    if (!to) return "Error: phoneNumber is required for initiate.";
    const from = opts.from || fromNumber;
    if (!from) return 'Error: No outbound number. Set TWILIO_PHONE_FROM in .env or pass optionsJson {"from":"+1555..."}';

    const webhookBase = (process.env.VOICE_WEBHOOK_BASE_URL || process.env.DAEMORA_PUBLIC_URL)?.replace(/\/$/, "");
    if (!webhookBase) {
      return "Error: VOICE_WEBHOOK_BASE_URL not set. Set it to your public URL (e.g. https://myagent.example.com) so Twilio can reach the webhooks.";
    }

    // Create session before the call so the webhook URL is ready
    const session = voiceSessionManager.create({
      callSid: null, // updated after Twilio responds
      greeting: opts.greeting || null,
    });

    // Store voice model preference on session for TaskRunner to pick up
    // Voice uses the fastest model by default (VOICE_MODEL env var or haiku/flash)
    session.preferredModel = opts.model || process.env.VOICE_MODEL || null;

    const body = {
      To:             to,
      From:           from,
      Url:            `${webhookBase}/voice/answer/${session.id}`,
      StatusCallback: `${webhookBase}/voice/status/${session.id}`,
      StatusCallbackMethod: "POST",
      Method: "POST",
    };
    if (opts.timeout) body.Timeout = String(opts.timeout);
    if (opts.record === true) body.Record = "true";
    if (opts.machineDetection) body.MachineDetection = opts.machineDetection;

    console.log(`[makeVoiceCall] Initiating interactive call to ${to} from ${from} | session ${session.id}`);
    const result = await _twilioRequest(accountSid, authToken, "POST", "/Calls.json", body);

    if (!result.ok) {
      voiceSessionManager.delete(session.id);
      return `Failed to initiate call: ${result.data?.message || result.data?.code || result.status}`;
    }

    // Update session with real callSid from Twilio
    session.callSid = result.data.sid;

    const d = result.data;
    return (
      `Interactive call started.\n` +
      `Session ID: ${session.id}  ← use this for listen/speak/end\n` +
      `Call SID:   ${d.sid}\n` +
      `Status:     ${d.status} (will update to "in-progress" when answered)\n` +
      `To:         ${d.to} | From: ${d.from}\n\n` +
      `Next step: call makeVoiceCall("listen", "${session.id}") to wait for the caller to speak.`
    );
  }

  // ── call — one-shot call that speaks a message and hangs up ─────────────────
  if (action === "call") {
    const to = phoneNumberOrSessionId;
    if (!to) return "Error: phoneNumber is required for call.";
    const from = opts.from || fromNumber;
    if (!from) return 'Error: No outbound number. Set TWILIO_PHONE_FROM in .env or pass optionsJson {"from":"+1555..."}';

    const body = { To: to, From: from };

    if (opts.url) {
      body.Url = opts.url;
    } else if (opts.message) {
      body.Twiml = _buildSayTwiML(opts.message, opts.voice || "Polly.Joanna", opts.language || "en-US");
    } else {
      return 'Error: Provide optionsJson {"message":"Hello"} to speak a message, or {"url":"https://twiml-url"} for custom TwiML.';
    }

    if (opts.statusCallback) body.StatusCallback = opts.statusCallback;
    if (opts.timeout) body.Timeout = String(opts.timeout);
    if (opts.record === true) body.Record = "true";

    console.log(`[makeVoiceCall] One-shot call to ${to} from ${from}`);
    const result = await _twilioRequest(accountSid, authToken, "POST", "/Calls.json", body);

    if (!result.ok) {
      return `Failed to initiate call: ${result.data?.message || result.data?.code || result.status}`;
    }

    const d = result.data;
    return `Call initiated. SID: ${d.sid} | Status: ${d.status} | To: ${d.to} | From: ${d.from}`;
  }

  // ── hangup — end a call by SID (non-session, admin use) ─────────────────────
  if (action === "hangup") {
    const sid = opts.sid || phoneNumberOrSessionId;
    if (!sid) return 'Error: Provide call SID via optionsJson {"sid":"CA..."} or as the second argument.';

    const result = await _twilioRequest(accountSid, authToken, "POST", `/Calls/${sid}.json`, { Status: "completed" });
    if (!result.ok) return `Failed to hang up: ${result.data?.message || result.status}`;
    return `Call ${result.data.sid} ended. Final status: ${result.data.status}`;
  }

  // ── list — recent calls ──────────────────────────────────────────────────────
  if (action === "list") {
    const limit = opts.limit || 20;
    const statusFilter = opts.status ? `&Status=${opts.status}` : "";
    const toFilter = opts.to ? `&To=${encodeURIComponent(opts.to)}` : "";

    const result = await _twilioRequest(
      accountSid, authToken, "GET",
      `/Calls.json?PageSize=${limit}${statusFilter}${toFilter}`
    );

    if (!result.ok) return `Failed to list calls: ${result.data?.message || result.status}`;

    const calls = result.data?.calls || [];
    if (calls.length === 0) return "No calls found.";

    const lines = calls.map((c) => {
      const dur = c.duration ? ` (${c.duration}s)` : "";
      return `  ${c.sid} | ${c.status.padEnd(12)} | ${c.to} ← ${c.from}${dur} | ${c.start_time || c.date_created}`;
    });
    return `Recent calls (${calls.length}):\n${lines.join("\n")}`;
  }

  return `Error: Unknown action "${action}". Supported: initiate, listen, speak, end, status, call, hangup, list.`;
}

export const makeVoiceCallDescription =
  'makeVoiceCall(action: string, phoneNumberOrSessionId?: string, optionsJson?: string) - Outbound voice calls via Twilio.\n' +
  'INTERACTIVE MODE (two-way conversation):\n' +
  '  action=initiate: start a call. optionsJson: {"greeting":"Hi, how can I help?","from":"+1555..."}. Returns sessionId.\n' +
  '  action=listen:   wait for caller to speak. First arg = sessionId. Returns: "Caller said: \\"...\\""\n' +
  '  action=speak:    say something to caller. First arg = sessionId. optionsJson: {"message":"Got it, one moment..."}\n' +
  '  action=end:      hang up the call. First arg = sessionId.\n' +
  '  action=status:   show session state and transcript. First arg = sessionId.\n' +
  'ONE-SHOT MODE:\n' +
  '  action=call:     dial a number and speak a message. optionsJson: {"message":"Your order is ready"} or {"url":"https://twiml-url"}\n' +
  '  action=hangup:   end a call by SID. optionsJson: {"sid":"CA..."}\n' +
  '  action=list:     recent calls. optionsJson: {"limit":20,"status":"completed","to":"+1555..."}\n' +
  'Credentials: TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_PHONE_FROM in .env. Interactive mode also needs VOICE_WEBHOOK_BASE_URL.';
