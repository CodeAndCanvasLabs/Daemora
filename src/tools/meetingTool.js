/**
 * meetingTool - Agent-facing tool for meeting management and voice cloning.
 *
 * Meeting bot dials into any meeting's phone number via Twilio.
 * OpenAI Realtime STT (native mu-law, server-side VAD) + ElevenLabs/OpenAI TTS.
 * No Docker, no browser - pure phone audio pipeline (same as OpenClaw).
 */

import { mergeLegacyParams as _mergeLegacy } from "../utils/mergeToolParams.js";
import {
  createSession,
  getSession,
  listSessions,
  addTranscript,
  updateState,
} from "../meeting/MeetingSessionManager.js";
import {
  joinMeeting,
  leaveMeeting,
  speakInMeeting,
  waitForMeetingEnd,
} from "../meeting/PhoneMeetingBot.js";
import {
  createClone,
  listVoices,
  deleteVoice,
  getVoice,
  listTenantVoices,
  getVoiceSettings,
  updateVoiceSettings,
} from "../voice/VoiceCloneManager.js";

export async function meetingAction(toolParams) {
  const action = toolParams?.action;
  const params = _mergeLegacy(toolParams);

  try {
    switch (action) {

      // ── Meeting lifecycle ──────────────────────────────────────────────────

      case "join": {
        const { dialIn, pin, displayName, voiceId, meetingUrl } = params;
        if (!dialIn) return "Error: dialIn (meeting phone number) is required. Every Google Meet/Zoom/Teams invite has a 'Join by phone' number.";

        const session = createSession(dialIn, { displayName, voiceId, pin, meetingUrl });
        updateState(session.id, "joining");
        const result = await joinMeeting(session.id, {
          dialIn,
          pin: pin || "",
          displayName: displayName || "Daemora",
        });
        return JSON.stringify(result);
      }

      case "leave": {
        const { sessionId } = params;
        if (!sessionId) return "Error: sessionId is required";
        return await leaveMeeting(sessionId);
      }

      // ── Audio interaction ──────────────────────────────────────────────────

      case "speak": {
        const { sessionId, text } = params;
        if (!sessionId || !text) return "Error: sessionId and text are required";
        return await speakInMeeting(sessionId, text);
      }

      // Blocks until the meeting ends - no polling needed.
      // Twilio media stream + OpenAI Realtime handles voice conversation autonomously.
      // Returns when call ends: {status: "meeting_ended", transcript: "..."}
      case "wait": {
        const { sessionId } = params;
        if (!sessionId) return "Error: sessionId is required";
        console.log(`[Meeting] wait: blocking on session ${sessionId} until call ends`);
        const result = await waitForMeetingEnd(sessionId);
        return JSON.stringify(result);
      }

      case "transcript": {
        const { sessionId, last } = params;
        if (!sessionId) return "Error: sessionId is required";
        const session = getSession(sessionId);
        if (!session) return `Error: session "${sessionId}" not found`;
        const entries = session.transcript.slice(-(parseInt(last || "50")));
        if (entries.length === 0) return "No transcript entries yet.";
        return entries.map(e => {
          const time = new Date(e.timestamp).toISOString().slice(11, 19);
          return `[${time}] ${e.speaker}: ${e.text}`;
        }).join("\n");
      }

      // ── Meeting state ──────────────────────────────────────────────────────

      case "status": {
        const { sessionId } = params;
        if (sessionId) {
          const session = getSession(sessionId);
          if (!session) return `Error: session "${sessionId}" not found`;
          return JSON.stringify({
            id: session.id,
            dialIn: session.dialIn,
            state: session.state,
            transcriptCount: session.transcriptCount,
            startedAt: session.startedAt,
          });
        }
        const sessions = listSessions();
        if (sessions.length === 0) return "No active meeting sessions.";
        return sessions.map(s =>
          `  ${s.id}: ${s.platform} (${s.state}) → ${s.dialIn}`
        ).join("\n");
      }

      // ── Voice cloning (ElevenLabs) ─────────────────────────────────────────

      case "cloneVoice": {
        const { name, samplePaths, description } = params;
        if (!name || !samplePaths) return "Error: name and samplePaths are required";
        const paths = Array.isArray(samplePaths) ? samplePaths : samplePaths.split(",").map(s => s.trim());
        const result = await createClone(name, paths, { description });
        return `Voice cloned: "${result.name}" (ID: ${result.voiceId})`;
      }

      case "listVoices": {
        const { source } = params;
        if (source === "tenant" || source === "local") {
          const voices = listTenantVoices();
          if (voices.length === 0) return "No cloned voices for this tenant.";
          return voices.map(v => `  ${v.voiceId}: ${v.name} (${v.createdAt})`).join("\n");
        }
        const voices = await listVoices();
        if (voices.length === 0) return "No voices available.";
        return voices.map(v =>
          `  ${v.voiceId}: ${v.name} [${v.category}]${v.isCloned ? " (cloned)" : ""}`
        ).join("\n");
      }

      case "deleteVoice": {
        const { voiceId } = params;
        if (!voiceId) return "Error: voiceId is required";
        await deleteVoice(voiceId);
        return `Voice ${voiceId} deleted.`;
      }

      case "voiceInfo": {
        const { voiceId } = params;
        if (!voiceId) return "Error: voiceId is required";
        return JSON.stringify(await getVoice(voiceId), null, 2);
      }

      case "voiceSettings": {
        const { voiceId, stability, similarityBoost, style, useSpeakerBoost } = params;
        if (!voiceId) return "Error: voiceId is required";
        if (stability !== undefined || similarityBoost !== undefined || style !== undefined || useSpeakerBoost !== undefined) {
          const settings = {};
          if (stability !== undefined) settings.stability = parseFloat(stability);
          if (similarityBoost !== undefined) settings.similarity_boost = parseFloat(similarityBoost);
          if (style !== undefined) settings.style = parseFloat(style);
          if (useSpeakerBoost !== undefined) settings.use_speaker_boost = useSpeakerBoost === "true" || useSpeakerBoost === true;
          await updateVoiceSettings(voiceId, settings);
          return `Voice settings updated for ${voiceId}`;
        }
        return JSON.stringify(await getVoiceSettings(voiceId), null, 2);
      }

      default:
        return `Unknown action: "${action}". Valid: join, leave, speak, wait, transcript, status, cloneVoice, listVoices, deleteVoice, voiceInfo, voiceSettings`;
    }
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

export const meetingActionDescription =
  `meetingAction(action: string, ...) - Join meetings via phone dial-in (Twilio) + OpenAI Realtime STT + ElevenLabs TTS.
  Meeting Actions:
    join       - {dialIn: "+14155550100", pin: "123456789", displayName: "Daemora", meetingUrl?: "..."} → dial into meeting via Twilio. Every Google Meet/Zoom/Teams invite has a phone number.
    leave      - {sessionId: "..."} → hang up
    speak      - {sessionId: "...", text: "..."} → TTS → inject audio into call
    wait       - {sessionId: "..."} → BLOCKS until call ends, returns full transcript. Bot converses autonomously via OpenAI Realtime STT + TTS.
    transcript - {sessionId: "...", last: 50} → get transcript entries
    status     - {sessionId?: "..."} → session status or list all
  Voice Cloning (ElevenLabs):
    cloneVoice    - {name: "My Voice", samplePaths: ["/path/audio.mp3"]} → create voice clone
    listVoices    - {source?: "tenant|all"} → list voices
    deleteVoice   - {voiceId: "..."} → delete voice
    voiceInfo     - {voiceId: "..."} → voice details
    voiceSettings - {voiceId: "...", stability?: 0.5, similarityBoost?: 0.75} → get/set voice settings
  Requires: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_FROM, DAEMORA_PUBLIC_URL in settings.`;
