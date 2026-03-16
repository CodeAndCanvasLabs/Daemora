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

// Per-session poll index — advances automatically so agent never needs to track since
const _pollIndex = new Map();

export async function meetingAction(toolParams) {
  const action = toolParams?.action;
  const params = _mergeLegacy(toolParams);

  try {
    switch (action) {

      // ── Meeting lifecycle ──────────────────────────────────────────────────

      case "join": {
        const { url, displayName, voiceId } = params;
        if (!url) return "Error: url is required";
        // TTS/STT always use server-configured models — agent doesn't choose providers
        const session = createSession(url, { displayName, voiceId });
        const result = await joinMeeting(session.id);
        return result;
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

        // Wait 5s before returning — natural conversation pace, avoids burning agent steps.
        await new Promise(r => setTimeout(r, 5000));

        const result = await getTranscript(sessionId, parseInt(last || "20"));
        if (result !== "No transcript entries yet.") return result;

        // Still empty — wait 5 more seconds
        await new Promise(r => setTimeout(r, 5000));
        const retry = await getTranscript(sessionId, parseInt(last || "20"));
        if (retry !== "No transcript entries yet.") return retry;

        return "Listening... no new speech in the last 10 seconds. Call listen again.";
      }

      // Index-based polling — auto-advances index internally, agent just calls poll repeatedly
      case "poll": {
        const { sessionId } = params;
        if (!sessionId) return "Error: sessionId is required";

        const sinceIdx = _pollIndex.get(sessionId) || 0;

        await new Promise(r => setTimeout(r, 2000));

        const data = await getTranscript(sessionId, 20, sinceIdx);
        if (typeof data === "string") return data;

        const { entries, total, nextSince, ended } = data;

        if (nextSince > sinceIdx) _pollIndex.set(sessionId, nextSince);

        if (ended) {
          _pollIndex.delete(sessionId);
          try { await leaveMeeting(sessionId); } catch {}
          return JSON.stringify({ entries: [], total, status: "meeting_ended" });
        }

        if (entries.length === 0) {
          return JSON.stringify({ entries: [], total, status: "no_new_speech" });
        }
        const formatted = entries.map(e => {
          const time = new Date(e.timestamp).toISOString().slice(11, 19);
          return `[${time}] ${e.speaker}: ${e.text}`;
        }).join("\n");
        return JSON.stringify({ entries: formatted, total, status: "new_speech" });
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
        return `Unknown action: "${action}". Valid: join, leave, speak, listen, poll, transcript, status, participants, mute, unmute, cloneVoice, listVoices, deleteVoice, voiceInfo, voiceSettings, setVoice`;
    }
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

export const meetingActionDescription =
  `meetingAction(action: string, paramsJson?: string) - Join video meetings (Zoom/Meet/Teams) and manage voice cloning.
  Meeting Actions:
    join           - {"url":"meeting-url","displayName":"Daemora"} → join meeting via browser (auto-detects platform). TTS/STT use server-configured models.
    leave          - {"sessionId":"..."} → leave meeting
    speak          - {"sessionId":"...","text":"..."} → TTS → inject audio into meeting
    listen         - {"sessionId":"...","last":20} → last N transcript entries (waits 5s)
    poll           - {"sessionId":"...","since":0} → NEW entries since index (waits 2s). Returns {entries,total,nextSince,status}. Use for meeting loops: poll → decide → speak → poll(nextSince) → ...
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
  TTS/STT use server-configured models automatically. Voice cloning requires ELEVENLABS_API_KEY.`;
