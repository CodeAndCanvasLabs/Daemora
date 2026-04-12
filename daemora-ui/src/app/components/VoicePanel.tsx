import { useEffect, useRef, useState, useCallback } from "react";
import { Room, RoomEvent, Track, RemoteTrack, RemoteAudioTrack, LocalAudioTrack, createLocalAudioTrack } from "livekit-client";
import { Mic, MicOff, Loader2, AlertCircle, PhoneOff } from "lucide-react";
import { apiFetch } from "../api";

type Status = "idle" | "connecting" | "listening" | "speaking" | "error";

function getOrCreateBrowserIdentity(): string {
  const KEY = "daemora_voice_identity";
  let id = sessionStorage.getItem(KEY);
  if (!id) {
    id = `daemora-user-${Math.random().toString(36).slice(2, 10)}`;
    sessionStorage.setItem(KEY, id);
  }
  return id;
}

// ── Animated Orb — circular voice visualizer ──────────────────────────────
function VoiceOrb({ level, status }: { level: number; status: Status }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef(0);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const cx = w / 2;
    const cy = h / 2;
    const baseRadius = Math.min(w, h) * 0.28;
    const time = frameRef.current * 0.015;
    frameRef.current++;

    ctx.clearRect(0, 0, w, h);

    // Outer glow rings
    const glowIntensity = status === "speaking" ? 0.3 + level * 0.5 : status === "listening" ? 0.15 + Math.sin(time * 2) * 0.08 : 0.05;
    for (let ring = 3; ring >= 1; ring--) {
      const ringRadius = baseRadius + ring * 18 + (status === "speaking" ? level * 25 : Math.sin(time + ring) * 4);
      const grad = ctx.createRadialGradient(cx, cy, ringRadius * 0.6, cx, cy, ringRadius);
      grad.addColorStop(0, `rgba(0, 217, 255, ${glowIntensity * 0.3 / ring})`);
      grad.addColorStop(0.5, `rgba(78, 205, 196, ${glowIntensity * 0.2 / ring})`);
      grad.addColorStop(1, "rgba(0, 217, 255, 0)");
      ctx.beginPath();
      ctx.arc(cx, cy, ringRadius, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
    }

    // Main orb — morphing blob
    const points = 64;
    ctx.beginPath();
    for (let i = 0; i <= points; i++) {
      const angle = (i / points) * Math.PI * 2;
      const noiseScale = status === "speaking" ? level * 0.35 : status === "listening" ? 0.06 : 0.02;
      const noise =
        Math.sin(angle * 3 + time * 3) * noiseScale * baseRadius +
        Math.sin(angle * 5 - time * 2) * noiseScale * baseRadius * 0.5 +
        Math.sin(angle * 7 + time * 4) * noiseScale * baseRadius * 0.3;
      const breathe = status === "listening" ? Math.sin(time * 1.5) * 3 : 0;
      const r = baseRadius + noise + breathe + (status === "speaking" ? level * 12 : 0);
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();

    // Gradient fill
    const grad = ctx.createRadialGradient(cx - baseRadius * 0.3, cy - baseRadius * 0.3, 0, cx, cy, baseRadius * 1.4);
    if (status === "speaking") {
      grad.addColorStop(0, "rgba(78, 205, 196, 0.95)");
      grad.addColorStop(0.5, "rgba(0, 217, 255, 0.85)");
      grad.addColorStop(1, "rgba(0, 150, 200, 0.6)");
    } else if (status === "listening") {
      grad.addColorStop(0, "rgba(0, 217, 255, 0.8)");
      grad.addColorStop(0.5, "rgba(0, 180, 220, 0.6)");
      grad.addColorStop(1, "rgba(78, 205, 196, 0.4)");
    } else {
      grad.addColorStop(0, "rgba(0, 217, 255, 0.3)");
      grad.addColorStop(0.5, "rgba(30, 80, 100, 0.2)");
      grad.addColorStop(1, "rgba(0, 100, 130, 0.1)");
    }
    ctx.fillStyle = grad;
    ctx.fill();

    // Inner highlight
    const innerGrad = ctx.createRadialGradient(cx - baseRadius * 0.2, cy - baseRadius * 0.3, 0, cx, cy, baseRadius * 0.7);
    innerGrad.addColorStop(0, "rgba(255, 255, 255, 0.15)");
    innerGrad.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx.fillStyle = innerGrad;
    ctx.fill();

    frameRef.current = requestAnimationFrame(draw);
  }, [level, status]);

  useEffect(() => {
    frameRef.current = requestAnimationFrame(draw);
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, [draw]);

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-full"
      style={{ maxWidth: 280, maxHeight: 280, margin: "0 auto", display: "block" }}
    />
  );
}

// ── Main VoicePanel ───────────────────────────────────────────────────────

interface VoicePanelProps {
  renderMicButton?: boolean;
}

export function VoicePanel({ renderMicButton = false }: VoicePanelProps) {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [avgLevel, setAvgLevel] = useState(0);
  const roomRef = useRef<Room | null>(null);
  const localTrackRef = useRef<LocalAudioTrack | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const identityRef = useRef<string>(getOrCreateBrowserIdentity());
  const startingRef = useRef(false);

  const cleanup = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    analyserRef.current = null;
    if (localTrackRef.current) {
      try { localTrackRef.current.stop(); } catch {}
      localTrackRef.current = null;
    }
    if (roomRef.current) {
      try { roomRef.current.disconnect(); } catch {}
      roomRef.current = null;
    }
    startingRef.current = false;
  };

  useEffect(() => {
    const onUnload = () => cleanup();
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []);

  const start = async () => {
    if (startingRef.current || roomRef.current) return;
    startingRef.current = true;
    setError(null);
    setStatus("connecting");
    try {
      try {
        const perm = await navigator.permissions.query({ name: "microphone" as PermissionName });
        if (perm.state === "denied") {
          throw new Error("Mic blocked — click the lock icon → Microphone → Allow, then reload.");
        }
      } catch (permErr: any) {
        if (permErr?.message?.includes("Mic blocked")) throw permErr;
      }

      const sc = await apiFetch("/api/voice/sidecar/start", { method: "POST" });
      if (!sc.ok) throw new Error(`sidecar: ${await sc.text()}`);

      const tokRes = await apiFetch("/api/voice/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identity: identityRef.current }),
      });
      if (!tokRes.ok) throw new Error(`token: ${tokRes.statusText}`);
      const { token, url } = await tokRes.json();

      const room = new Room({ adaptiveStream: true, dynacast: true });
      roomRef.current = room;

      room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
        if (track.kind === Track.Kind.Audio) {
          const audio = track as RemoteAudioTrack;
          if (audioElRef.current) audio.attach(audioElRef.current);
          try {
            const ms = audio.mediaStreamTrack ? new MediaStream([audio.mediaStreamTrack]) : null;
            if (ms) {
              const AudioCtx = (window.AudioContext || (window as any).webkitAudioContext);
              const ctx = new AudioCtx();
              const src = ctx.createMediaStreamSource(ms);
              const analyser = ctx.createAnalyser();
              analyser.fftSize = 128;
              src.connect(analyser);
              analyserRef.current = analyser;
              const buf = new Uint8Array(analyser.frequencyBinCount);
              const tick = () => {
                if (!analyserRef.current) return;
                analyserRef.current.getByteFrequencyData(buf);
                const avg = buf.reduce((a, b) => a + b, 0) / buf.length / 255;
                setAvgLevel(avg);
                setStatus(avg > 0.04 ? "speaking" : "listening");
                rafRef.current = requestAnimationFrame(tick);
              };
              tick();
            }
          } catch {}
        }
      });

      room.on(RoomEvent.Disconnected, () => {
        setStatus("idle");
        setAvgLevel(0);
      });

      await room.connect(url, token);

      let micTrack;
      try {
        micTrack = await createLocalAudioTrack({
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        });
      } catch (micErr: any) {
        const msg = micErr?.name === "NotAllowedError"
          ? "Mic denied — click the lock icon → Microphone → Allow."
          : micErr?.name === "NotFoundError"
          ? "No microphone found."
          : `Mic: ${micErr?.message || micErr}`;
        throw new Error(msg);
      }
      localTrackRef.current = micTrack;
      await room.localParticipant.publishTrack(micTrack);
      setStatus("listening");
      startingRef.current = false;
    } catch (e: any) {
      setError(e?.message || String(e));
      setStatus("error");
      cleanup();
    }
  };

  const stop = () => {
    cleanup();
    setStatus("idle");
    setAvgLevel(0);
  };

  const active = status !== "idle" && status !== "error";

  // ── Mic button for the input bar ──────────────────────────────────────
  if (renderMicButton) {
    return (
      <>
        <button
          onClick={active ? stop : start}
          disabled={status === "connecting"}
          title={active ? "End voice" : "Start voice"}
          className={`flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center transition-all ${
            status === "error"
              ? "bg-red-500/20 text-red-400 hover:bg-red-500/30"
              : active
              ? "bg-gradient-to-br from-[#00d9ff] to-[#4ECDC4] text-slate-950 shadow-[0_0_15px_rgba(0,217,255,0.4)]"
              : "bg-slate-700/50 text-gray-500 hover:text-[#00d9ff] hover:bg-slate-700"
          }`}
        >
          {status === "connecting" ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : status === "error" ? (
            <AlertCircle className="w-3.5 h-3.5" />
          ) : active ? (
            <PhoneOff className="w-3.5 h-3.5" />
          ) : (
            <Mic className="w-4 h-4" />
          )}
        </button>
        <audio ref={audioElRef} autoPlay hidden />
      </>
    );
  }

  // ── Orb + status (only rendered when voice is active) ─────────────────
  if (!active && !error) return null;

  return (
    <div className="w-full shrink-0">
      <div className="max-w-xl mx-auto px-4 py-2">
        {/* Status + End button */}
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            {status === "listening" && (
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full rounded-full bg-[#00d9ff] opacity-75 animate-ping" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-[#00d9ff]" />
              </span>
            )}
            {status === "speaking" && (
              <span className="relative flex h-2 w-2">
                <span className="relative inline-flex h-2 w-2 rounded-full bg-[#4ECDC4]" />
              </span>
            )}
            <span className={`text-[10px] font-mono uppercase tracking-[0.15em] ${
              status === "speaking" ? "text-[#4ECDC4]" : status === "listening" ? "text-[#00d9ff]" : "text-gray-500"
            }`}>
              {status === "connecting" ? "Connecting…" : status === "listening" ? "Listening" : status === "speaking" ? "Speaking" : ""}
            </span>
          </div>
          <button
            onClick={stop}
            className="flex items-center gap-1 text-[9px] font-mono uppercase tracking-wider text-gray-500 hover:text-red-400 transition-colors px-2 py-1 rounded hover:bg-red-500/10"
          >
            <PhoneOff className="w-3 h-3" /> End
          </button>
        </div>

        {/* Animated Orb */}
        <div className="w-full aspect-square max-w-[200px] mx-auto">
          <VoiceOrb level={avgLevel} status={status} />
        </div>

        {/* Error */}
        {error && (
          <p className="text-[10px] text-red-400/90 font-mono text-center mt-2 max-w-sm mx-auto">
            {error}
          </p>
        )}
      </div>
      <audio ref={audioElRef} autoPlay hidden />
    </div>
  );
}
