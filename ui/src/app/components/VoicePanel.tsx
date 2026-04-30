import { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from "react";
import { Loader2, AlertCircle } from "lucide-react";
import { Room, RoomEvent, Track, type RemoteTrack, type RemoteParticipant } from "livekit-client";

import { apiFetch } from "../api";

type Status = "idle" | "connecting" | "listening" | "capturing" | "thinking" | "speaking" | "error";

// ── Orb with flowing luminous curves inside a dark sphere ─────────────────
function VoiceOrb({ level, status, size }: { level: number; status: Status; size: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf: number;

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = size;
      const h = size;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const cx = w / 2;
      const cy = h / 2;
      const radius = w * 0.42;
      tRef.current += status === "speaking" ? 0.025 : status === "listening" || status === "capturing" ? 0.012 : status === "thinking" ? 0.018 : 0.006;
      const t = tRef.current;

      ctx.clearRect(0, 0, w, h);

      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();

      // No sphere fill — the orb is just the luminous curves floating on
      // top of the chat background. Keeps messages visible behind it.

      const curveCount = 5;
      const intensity = status === "speaking" ? 0.6 + level * 1.5
        : status === "capturing" ? 0.5 + level * 1.2
        : status === "listening" ? 0.35
        : status === "thinking" ? 0.4 + Math.sin(t * 3) * 0.15
        : 0.12;

      for (let c = 0; c < curveCount; c++) {
        const phase = (c / curveCount) * Math.PI * 2;
        const hue1 = status === "speaking" ? [78, 205, 196]
          : status === "thinking" ? [108, 138, 255]
          : [0, 217, 255];

        ctx.beginPath();
        ctx.lineWidth = 1.2 + intensity * 1.5;

        const points = 80;
        for (let i = 0; i <= points; i++) {
          const p = i / points;
          const angle = p * Math.PI * 2;
          const orbitX = Math.cos(angle + t + phase) * radius * 0.6;
          const orbitY = Math.sin(angle * 2 + t * 1.3 + phase) * radius * 0.35;
          const wave1 = Math.sin(angle * 3 + t * 2 + phase) * radius * 0.15 * intensity;
          const wave2 = Math.cos(angle * 5 - t * 1.5 + phase * 2) * radius * 0.08 * intensity;
          const wave3 = Math.sin(angle * 7 + t * 3) * radius * 0.05 * intensity;
          const x = cx + orbitX + wave1 + wave3;
          const y = cy + orbitY + wave2;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }

        const alpha = (0.15 + intensity * 0.4) * (1 - c * 0.12);
        ctx.strokeStyle = `rgba(${hue1[0]}, ${hue1[1]}, ${hue1[2]}, ${alpha})`;
        ctx.stroke();
      }
      ctx.restore();

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [level, status, size]);

  return <canvas ref={canvasRef} />;
}

// ── Main VoicePanel — LiveKit Room join ─────────────────────────────────

export interface VoiceHandle {
  start: () => void;
  stop: () => void;
  status: Status;
  active: boolean;
}

export interface VoicePanelProps {
  /** Fires on each final user transcript (from agent session transcriptions). */
  onUserTranscript?: (text: string) => void;
  /** Fires on each assistant text delta during a turn. */
  onAssistantDelta?: (delta: string) => void;
  /** Fires when the assistant's current turn finishes. */
  onAssistantDone?: () => void;
}

export const VoicePanel = forwardRef<VoiceHandle, VoicePanelProps>(function VoicePanel(props, ref) {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState(0);

  const roomRef = useRef<Room | null>(null);
  const connectedRef = useRef(false);  // true once room.connect() resolved
  const startingRef = useRef(false);
  const propsRef = useRef(props);
  propsRef.current = props;

  useImperativeHandle(ref, () => ({
    start, stop, status, active: status !== "idle" && status !== "error",
  }), [status]);

  const cleanup = useCallback(() => {
    // Only disconnect if the room has fully connected. Calling
    // disconnect() while connect() is still in-flight fires LiveKit's
    // internal abort handler ("could not establish signal connection:
    // Abort handler called"). React strict-mode mount/unmount and any
    // transient re-render that unmounts VoicePanel will hit this race.
    if (roomRef.current && connectedRef.current) {
      try { roomRef.current.disconnect(); } catch {}
      roomRef.current = null;
    }
    connectedRef.current = false;
    startingRef.current = false;
    setLevel(0);
  }, []);

  useEffect(() => () => cleanup(), [cleanup]);

  const start = async () => {
    if (startingRef.current || roomRef.current) return;
    startingRef.current = true;
    setError(null);
    setStatus("connecting");

    try {
      // 1. Ensure the LiveKit agent worker is running.
      await apiFetch("/api/voice/sidecar/start", { method: "POST" });

      // 2. Ask the server for a room token. Unique room per session —
      // reusing a single name leaves stale AgentSession state behind
      // from previous taps (closeOnDisconnect:false is intentional, so
      // the agent worker survives user disconnects), which breaks STT
      // subscription for the new user. Timestamp-scoped rooms give us
      // a fresh dispatch every time with no carryover bindings.
      const sessionTs = Date.now();
      const tokenResp = await apiFetch("/api/voice/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room: `daemora-${sessionTs}`, identity: `user-${sessionTs}` }),
      });
      if (!tokenResp.ok) throw new Error(`Token request failed: ${tokenResp.status}`);
      const { token, url } = await tokenResp.json() as { token: string; url: string };

      // 3. Join the room.
      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
        audioCaptureDefaults: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      roomRef.current = room;

      room
        .on(RoomEvent.Connected, () => {
          setStatus("listening");
        })
        .on(RoomEvent.Disconnected, () => {
          setStatus("idle");
          cleanup();
        })
        .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, participant: RemoteParticipant) => {
          if (track.kind === Track.Kind.Audio) {
            const el = track.attach() as HTMLAudioElement;
            el.style.display = "none";
            el.autoplay = true;
            el.muted = false;
            el.volume = 1;
            document.body.appendChild(el);
            // Chrome's autoplay policy silently pauses <audio> elements
            // whose srcObject was set outside the original user gesture.
            // track.attach() triggers .play() internally but doesn't
            // report failures — so we force it and log, otherwise the
            // UI shows "Speaking..." but nothing is audible.
            void el.play().catch((err: unknown) => {
              console.warn("[voice] audio element play() rejected:", err);
            });
            setStatus("speaking");
            void participant;
          }
        })
        .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
          track.detach().forEach((el) => el.remove());
        })
        .on(RoomEvent.TranscriptionReceived, (segments, participant) => {
          // LiveKit publishes transcriptions for every participant. The
          // agent's identity starts with "agent-" (assigned by LiveKit's
          // worker dispatch); anything else is the human user.
          const identity = participant?.identity ?? "";
          const isAgent = identity.startsWith("agent-") || identity === room.localParticipant.identity === false;
          const isLocal = identity === room.localParticipant.identity;
          for (const seg of segments) {
            if (!seg.final) continue;
            if (!isLocal && (isAgent || identity.startsWith("agent"))) {
              propsRef.current.onAssistantDelta?.(seg.text);
              propsRef.current.onAssistantDone?.();
            } else if (isLocal) {
              propsRef.current.onUserTranscript?.(seg.text);
            } else {
              // Unknown participant — default to agent since any non-local
              // speaker in a voice room is the bot.
              propsRef.current.onAssistantDelta?.(seg.text);
              propsRef.current.onAssistantDone?.();
            }
          }
        })
        .on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
          const local = speakers.find((s) => s.identity === room.localParticipant.identity);
          setLevel(local?.audioLevel ?? 0);
          const remoteActive = speakers.some((s) => s.identity !== room.localParticipant.identity);
          if (!remoteActive && status === "speaking") setStatus("listening");
        });

      await room.connect(url, token);
      connectedRef.current = true;
      // Resume the shared Web Audio context — without this, Chromium
      // keeps it suspended on first session because track.attach() runs
      // after the click-to-start gesture has already "fired". Calling
      // startAudio() from inside the click handler chain is what
      // actually unblocks playback.
      try { await room.startAudio(); } catch (e) { console.warn("[voice] startAudio failed:", e); }
      await room.localParticipant.setMicrophoneEnabled(true);
    } catch (err: any) {
      setError(err?.message ?? "Failed to start voice");
      setStatus("error");
      // On error path the room exists but may be in an indeterminate
      // state — force-disconnect (the abort error already surfaced; a
      // second disconnect is a no-op).
      if (roomRef.current) {
        try { roomRef.current.disconnect(); } catch {}
        roomRef.current = null;
      }
      connectedRef.current = false;
      startingRef.current = false;
      setLevel(0);
    }
  };

  const stop = () => {
    setStatus("idle");
    if (roomRef.current) {
      try { roomRef.current.disconnect(); } catch {}
      roomRef.current = null;
    }
    connectedRef.current = false;
    startingRef.current = false;
    setLevel(0);
  };

  const statusLabel = {
    idle: "Tap to talk",
    connecting: "Connecting...",
    listening: "Listening...",
    capturing: "Hearing you...",
    thinking: "Thinking...",
    speaking: "Speaking...",
    error: error || "Error",
  }[status];

  const statusColor = {
    idle: "text-gray-500",
    connecting: "text-yellow-400",
    listening: "text-emerald-400",
    capturing: "text-amber-400",
    thinking: "text-blue-400",
    speaking: "text-purple-400",
    error: "text-red-400",
  }[status];

  return (
    <div className="flex flex-col items-center gap-4 py-4">
      <div className={`text-[11px] font-mono tracking-wider uppercase ${statusColor}`}>
        {statusLabel}
      </div>
      <div
        className="cursor-pointer"
        onClick={() => (status === "idle" || status === "error" ? start() : stop())}
      >
        <VoiceOrb level={level} status={status} size={180} />
      </div>
      {status === "connecting" && (
        <Loader2 className="w-4 h-4 animate-spin text-yellow-400" />
      )}
      {status === "error" && (
        <div className="flex items-center gap-2 text-red-400 text-xs font-mono">
          <AlertCircle className="w-3.5 h-3.5" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
});
