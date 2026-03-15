/**
 * meetingTool — Agent-facing tool for meeting management and voice cloning.
 *
 * Action-based dispatch (same pattern as teamTool.js).
 * Covers: join/leave meetings, speak/listen, transcripts, participants,
 * voice cloning (ElevenLabs), voice management.
 */

import { mergeLegacyParams as _mergeLegacy } from "../utils/mergeToolParams.js";
import {
  createSession,
  getSession,
  listSessions,
} from "../meeting/MeetingSessionManager.js";
import {
  joinMeeting,
  leaveMeeting,
  speakInMeeting,
  getTranscript,
  getParticipants,
  toggleMute,
  getRecording,
} from "../meeting/BrowserMeetingBot.js";
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
        const { url, displayName, voiceId, sttProvider, ttsProvider } = params;
        if (!url) return "Error: url is required";
        // Browser profile auto-set to meeting-{platform} (enables stealth + headed mode)
        // Agent profile (meeting-attendant) is separate from browser profile
        const session = createSession(url, { displayName, voiceId, sttProvider, ttsProvider });
        const result = await joinMeeting(session.id);
        return `${result}\nSession ID: ${session.id} | Platform: ${session.platform}`;
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

      case "listen": {
        const { sessionId, last } = params;
        if (!sessionId) return "Error: sessionId is required";

        // ALWAYS wait 5 seconds before returning — prevents agent from burning step budget.
        // Each listen = one "turn" of the meeting loop. ~5s gap = natural conversation pace.
        // With maxLoops=100, this gives ~8 minutes of meeting time.
        await new Promise(r => setTimeout(r, 5000));

        const result = getTranscript(sessionId, parseInt(last || "20"));
        if (result !== "No transcript entries yet.") return result;

        // If still empty, wait 5 more seconds
        await new Promise(r => setTimeout(r, 5000));
        const retry = getTranscript(sessionId, parseInt(last || "20"));
        if (retry !== "No transcript entries yet.") return retry;

        return "Listening... no new speech in the last 10 seconds. Call listen again.";
      }

      case "transcript": {
        const { sessionId, last } = params;
        if (!sessionId) return "Error: sessionId is required";
        return getTranscript(sessionId, parseInt(last || "50"));
      }

      case "getRecording": {
        const { sessionId } = params;
        if (!sessionId) return "Error: sessionId is required";
        return getRecording(sessionId);
      }

      // ── Meeting state ──────────────────────────────────────────────────────

      case "status": {
        const { sessionId } = params;
        if (sessionId) {
          const session = getSession(sessionId);
          if (!session) return `Error: session "${sessionId}" not found`;
          return JSON.stringify(session, null, 2);
        }
        // List all sessions
        const sessions = listSessions();
        if (sessions.length === 0) return "No active meeting sessions.";
        return sessions.map(s =>
          `  ${s.id}: ${s.platform} (${s.state}) — ${s.meetingUrl.slice(0, 60)}`
        ).join("\n");
      }

      case "participants": {
        const { sessionId } = params;
        if (!sessionId) return "Error: sessionId is required";
        return await getParticipants(sessionId);
      }

      case "mute": {
        const { sessionId } = params;
        if (!sessionId) return "Error: sessionId is required";
        return await toggleMute(sessionId, true);
      }

      case "unmute": {
        const { sessionId } = params;
        if (!sessionId) return "Error: sessionId is required";
        return await toggleMute(sessionId, false);
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
        const info = await getVoice(voiceId);
        return JSON.stringify(info, null, 2);
      }

      case "voiceSettings": {
        const { voiceId, stability, similarityBoost, style, useSpeakerBoost } = params;
        if (!voiceId) return "Error: voiceId is required";

        // If settings provided, update
        if (stability !== undefined || similarityBoost !== undefined || style !== undefined || useSpeakerBoost !== undefined) {
          const settings = {};
          if (stability !== undefined) settings.stability = parseFloat(stability);
          if (similarityBoost !== undefined) settings.similarity_boost = parseFloat(similarityBoost);
          if (style !== undefined) settings.style = parseFloat(style);
          if (useSpeakerBoost !== undefined) settings.use_speaker_boost = useSpeakerBoost === "true" || useSpeakerBoost === true;
          await updateVoiceSettings(voiceId, settings);
          return `Voice settings updated for ${voiceId}`;
        }

        // Otherwise, get settings
        const settings = await getVoiceSettings(voiceId);
        return JSON.stringify(settings, null, 2);
      }

      case "setVoice": {
        const { sessionId, voiceId } = params;
        if (!sessionId || !voiceId) return "Error: sessionId and voiceId are required";
        const session = getSession(sessionId);
        if (!session) return `Error: session "${sessionId}" not found`;
        // Update voice on raw session
        const { _getRawSession } = await import("../meeting/MeetingSessionManager.js");
        const raw = _getRawSession(sessionId);
        if (raw) raw.audioConfig.voiceId = voiceId;
        return `Voice set to ${voiceId} for session ${sessionId}`;
      }

      default:
        return `Unknown action: "${action}". Valid: join, leave, speak, listen, transcript, status, participants, mute, unmute, cloneVoice, listVoices, deleteVoice, voiceInfo, voiceSettings, setVoice`;
    }
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

export const meetingActionDescription =
  `meetingAction(action: string, paramsJson?: string) - Join video meetings (Zoom/Meet/Teams) and manage voice cloning.
  Meeting Actions:
    join           - {"url":"meeting-url","displayName":"Daemora","voiceId":"...","sttProvider":"whisper","ttsProvider":"elevenlabs"} → join meeting via browser (auto-detects platform)
    leave          - {"sessionId":"..."} → leave meeting
    speak          - {"sessionId":"...","text":"..."} → TTS → inject audio into meeting
    listen         - {"sessionId":"...","last":20} → recent transcript entries
    transcript     - {"sessionId":"...","last":50} → full transcript
    status         - {"sessionId":"..."} → session status, or list all sessions if no sessionId
    participants   - {"sessionId":"..."} → list meeting participants
    mute           - {"sessionId":"..."} → mute microphone
    unmute         - {"sessionId":"..."} → unmute microphone
  Voice Cloning (ElevenLabs):
    cloneVoice     - {"name":"My Voice","samplePaths":["/path/to/sample.mp3"]} → create instant voice clone
    listVoices     - {"source":"tenant|all"} → list available voices
    deleteVoice    - {"voiceId":"..."} → delete cloned voice
    voiceInfo      - {"voiceId":"..."} → detailed voice info
    voiceSettings  - {"voiceId":"...","stability":0.5,"similarityBoost":0.75} → get/update voice settings
    setVoice       - {"sessionId":"...","voiceId":"..."} → change active voice for meeting session
  Requires: Playwright for meetings, ELEVENLABS_API_KEY for voice cloning, OPENAI_API_KEY for TTS/STT.`;
