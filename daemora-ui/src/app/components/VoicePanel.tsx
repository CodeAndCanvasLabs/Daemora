import { useEffect, useRef, useState, useCallback } from "react";
import { Room, RoomEvent, Track, RemoteTrack, RemoteAudioTrack, LocalAudioTrack, createLocalAudioTrack } from "livekit-client";
import { Loader2, Mic, PhoneOff, AlertCircle } from "lucide-react";
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

// ── Orb with flowing luminous curves inside a dark sphere ─────────────────
function VoiceOrb({ level, status, size }: { level: number; status: Status; size: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<number>(0);
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
      tRef.current += status === "speaking" ? 0.025 : status === "listening" ? 0.012 : 0.006;
      const t = tRef.current;

      ctx.clearRect(0, 0, w, h);

      // Outer glow
      const glowSize = status === "speaking" ? 0.55 + level * 0.3 : status === "listening" ? 0.35 : 0.15;
      const outerGlow = ctx.createRadialGradient(cx, cy, radius * 0.8, cx, cy, radius * 1.5);
      outerGlow.addColorStop(0, `rgba(0, 217, 255, ${glowSize * 0.25})`);
      outerGlow.addColorStop(0.5, `rgba(78, 205, 196, ${glowSize * 0.12})`);
      outerGlow.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx.fillStyle = outerGlow;
      ctx.fillRect(0, 0, w, h);

      // Dark sphere background
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();

      const sphereGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
      sphereGrad.addColorStop(0, "rgba(15, 25, 35, 0.95)");
      sphereGrad.addColorStop(0.7, "rgba(8, 15, 25, 0.98)");
      sphereGrad.addColorStop(1, "rgba(0, 10, 20, 1)");
      ctx.fillStyle = sphereGrad;
      ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);

      // Flowing luminous curves inside the sphere
      const curveCount = 5;
      const intensity = status === "speaking" ? 0.6 + level * 1.5 : status === "listening" ? 0.35 : 0.12;

      for (let c = 0; c < curveCount; c++) {
        const phase = (c / curveCount) * Math.PI * 2;
        const hue1 = status === "speaking" ? [78, 205, 196] : [0, 217, 255]; // teal vs cyan
        const hue2 = [0, 180, 220];

        ctx.beginPath();
        ctx.lineWidth = 1.2 + intensity * 1.5;

        const points = 80;
        for (let i = 0; i <= points; i++) {
          const p = i / points;
          const angle = p * Math.PI * 2;

          // Orbital path with wave perturbation
          const orbitX = Math.cos(angle + t + phase) * radius * 0.6;
          const orbitY = Math.sin(angle * 2 + t * 1.3 + phase) * radius * 0.35;

          // Wave displacement driven by audio
          const wave1 = Math.sin(angle * 3 + t * 2 + phase) * radius * 0.15 * intensity;
          const wave2 = Math.cos(angle * 5 - t * 1.5 + phase * 2) * radius * 0.08 * intensity;
          const wave3 = Math.sin(angle * 7 + t * 3) * radius * 0.05 * intensity;

          const x = cx + orbitX + wave1 + wave3;
          const y = cy + orbitY + wave2;

          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }

        const alpha = (0.15 + intensity * 0.4) * (1 - c * 0.12);
        const r = Math.round(hue1[0] + (hue2[0] - hue1[0]) * (c / curveCount));
        const g = Math.round(hue1[1] + (hue2[1] - hue1[1]) * (c / curveCount));
        const b = Math.round(hue1[2] + (hue2[2] - hue1[2]) * (c / curveCount));
        ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
        ctx.shadowColor = `rgba(${r}, ${g}, ${b}, ${alpha * 0.6})`;
        ctx.shadowBlur = 8 + intensity * 12;
        ctx.stroke();
        ctx.shadowBlur = 0;
      }

      // Inner core glow
      const coreGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * 0.5);
      const coreAlpha = status === "speaking" ? 0.15 + level * 0.2 : status === "listening" ? 0.08 : 0.03;
      coreGrad.addColorStop(0, `rgba(0, 217, 255, ${coreAlpha})`);
      coreGrad.addColorStop(0.5, `rgba(78, 205, 196, ${coreAlpha * 0.5})`);
      coreGrad.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx.fillStyle = coreGrad;
      ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);

      ctx.restore();

      // Sphere border ring
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      const borderAlpha = status === "speaking" ? 0.4 : status === "listening" ? 0.25 : 0.1;
      ctx.strokeStyle = `rgba(0, 217, 255, ${borderAlpha})`;
      ctx.lineWidth = 1.5;
      ctx.stroke();

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [size, level, status]);

  return <canvas ref={canvasRef} />;
}

// ── Main VoicePanel ───────────────────────────────────────────────────────

export function VoicePanel() {
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

  return (
    <div className="w-full shrink-0">
      {/* Orb — only when active */}
      {active && (
        <div className="flex flex-col items-center py-4">
          <div className="flex items-center gap-3 mb-3">
        {status === "listening" && (
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full rounded-full bg-[#00d9ff] opacity-75 animate-ping" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-[#00d9ff]" />
          </span>
        )}
        {status === "speaking" && <span className="h-2 w-2 rounded-full bg-[#4ECDC4]" />}
        <span className={`text-[10px] font-mono uppercase tracking-[0.15em] ${
          status === "speaking" ? "text-[#4ECDC4]" : status === "listening" ? "text-[#00d9ff]" : "text-gray-500"
        }`}>
          {status === "connecting" ? "Connecting…" : status === "listening" ? "Listening" : status === "speaking" ? "Speaking" : ""}
        </span>
        <button onClick={stop} className="text-[9px] font-mono uppercase tracking-wider text-gray-600 hover:text-red-400 transition-colors px-2 py-0.5 rounded hover:bg-red-500/10 ml-2">
          End
        </button>
      </div>

      {/* Orb */}
      <div style={{ width: 180, height: 180 }}>
        <VoiceOrb level={avgLevel} status={status} size={180} />
      </div>

          {/* Error */}
          {error && (
            <p className="text-[10px] text-red-400/90 font-mono text-center mt-2 max-w-xs">{error}</p>
          )}
        </div>
      )}

      {/* Mic toggle button — always visible, right-aligned */}
      <div className="flex justify-end px-4 max-w-3xl mx-auto w-full">
        <button
          onClick={active ? stop : start}
          disabled={status === "connecting"}
          title={active ? "End voice" : "Start voice"}
          className={`w-10 h-10 rounded-full flex items-center justify-center transition-all ${
            status === "error"
              ? "bg-red-500/20 text-red-400 hover:bg-red-500/30 border border-red-400/30"
              : status === "connecting"
              ? "bg-slate-700/50 text-[#00d9ff]"
              : active
              ? "bg-gradient-to-br from-[#00d9ff] to-[#4ECDC4] text-slate-950 shadow-[0_0_20px_rgba(0,217,255,0.4)]"
              : "bg-slate-800/60 border border-slate-700/60 text-gray-500 hover:text-[#00d9ff] hover:border-[#00d9ff]/40 hover:shadow-[0_0_12px_rgba(0,217,255,0.2)]"
          }`}
        >
          {status === "connecting" ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : active ? (
            <PhoneOff className="w-4 h-4" />
          ) : (
            <Mic className="w-4 h-4" />
          )}
        </button>
      </div>

      <audio ref={audioElRef} autoPlay hidden />
    </div>
  );
}
