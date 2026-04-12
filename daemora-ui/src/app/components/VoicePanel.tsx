import { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from "react";
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

      // Clip all drawing to the circle — NO dark fill, fully transparent
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();

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

      ctx.restore();

      // Sphere border ring — subtle glow outside the clip
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      const borderAlpha = status === "speaking" ? 0.5 : status === "listening" ? 0.3 : 0.12;
      ctx.strokeStyle = `rgba(0, 217, 255, ${borderAlpha})`;
      ctx.lineWidth = 2;
      ctx.shadowColor = `rgba(0, 217, 255, ${borderAlpha * 0.8})`;
      ctx.shadowBlur = 15;
      ctx.stroke();
      ctx.shadowBlur = 0;

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [size, level, status]);

  return <canvas ref={canvasRef} />;
}

// ── Main VoicePanel ───────────────────────────────────────────────────────

export interface VoiceHandle {
  start: () => void;
  stop: () => void;
  status: Status;
  active: boolean;
}

export const VoicePanel = forwardRef<VoiceHandle>(function VoicePanel(_props, ref) {
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

  useImperativeHandle(ref, () => ({
    start, stop, status, active: status !== "idle" && status !== "error",
  }), [status]);

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
    apiFetch("/api/voice/sidecar/stop", { method: "POST" }).catch(() => {});
  };

  const active = status !== "idle" && status !== "error";

  if (!active && !error) return <audio ref={audioElRef} autoPlay hidden />;

  return (
    <>
      {/* Fixed overlay — outside layout flow, doesn't push anything */}
      <div className="fixed inset-0 z-50 pointer-events-none flex items-end justify-center pb-32">
        <div className="pointer-events-auto flex flex-col items-center gap-2">
          <div className="flex items-center gap-2">
            {status === "listening" && (
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full rounded-full bg-[#00d9ff] opacity-75 animate-ping" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-[#00d9ff]" />
              </span>
            )}
            {status === "speaking" && <span className="h-2 w-2 rounded-full bg-[#4ECDC4]" />}
            <span className={`text-[10px] font-mono uppercase tracking-wider ${
              status === "speaking" ? "text-[#4ECDC4]" : "text-[#00d9ff]"
            }`}>
              {status === "listening" ? "Listening" : status === "speaking" ? "Speaking" : ""}
            </span>
            <button onClick={stop} className="text-[9px] font-mono uppercase text-gray-500 hover:text-red-400 ml-1 px-2 py-0.5 rounded hover:bg-red-500/10 transition-colors">
              End
            </button>
          </div>
          <button onClick={stop} title="End voice" className="hover:scale-105 active:scale-95 transition-transform">
            <div style={{ width: 160, height: 160 }}>
              <VoiceOrb level={avgLevel} status={status} size={160} />
            </div>
          </button>
          {error && <p className="text-[9px] text-red-400 font-mono text-center max-w-xs">{error}</p>}
        </div>
      </div>
      <audio ref={audioElRef} autoPlay hidden />
    </>
  );
});
