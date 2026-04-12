import { useEffect, useRef, useState } from "react";
import { Room, RoomEvent, Track, RemoteTrack, RemoteAudioTrack, LocalAudioTrack, createLocalAudioTrack } from "livekit-client";
import { Mic, MicOff, Loader2, AlertCircle } from "lucide-react";
import { apiFetch } from "../api";

type Status = "idle" | "connecting" | "listening" | "speaking" | "error";

// Per-browser-session identity — stable across re-renders of VoicePanel
// so reconnect attempts aren't evicted by identity collision, but unique
// across tabs / devices so two clients can coexist later.
function getOrCreateBrowserIdentity(): string {
  const KEY = "daemora_voice_identity";
  let id = sessionStorage.getItem(KEY);
  if (!id) {
    id = `daemora-user-${Math.random().toString(36).slice(2, 10)}`;
    sessionStorage.setItem(KEY, id);
  }
  return id;
}

export function VoicePanel() {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [agentLevel, setAgentLevel] = useState<number[]>(Array(24).fill(0));
  const roomRef = useRef<Room | null>(null);
  const localTrackRef = useRef<LocalAudioTrack | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const identityRef = useRef<string>(getOrCreateBrowserIdentity());
  // Guard against React StrictMode double-invoking the effect cleanup
  // between the two mount+unmount+remount cycles — we only want to tear
  // down the room when the component is actually leaving the DOM, not
  // when StrictMode is toggling us.
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

  // NO useEffect cleanup — StrictMode would fire it between the paired
  // mount/unmount and kill the room the user just started. Cleanup is
  // driven by the stop() button and on actual page unload below.
  useEffect(() => {
    const onUnload = () => cleanup();
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []);

  const start = async () => {
    if (startingRef.current || roomRef.current) {
      // Already starting or running — don't fire a second connect
      return;
    }
    startingRef.current = true;
    setError(null);
    setStatus("connecting");
    try {
      // 1. Ask Daemora to start the sidecar voice pipeline (idempotent)
      const sc = await apiFetch("/api/voice/sidecar/start", { method: "POST" });
      if (!sc.ok) {
        const text = await sc.text();
        throw new Error(`sidecar: ${text || sc.statusText}`);
      }

      // 2. Mint a user-side JWT from Daemora
      const tokRes = await apiFetch("/api/voice/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identity: identityRef.current }),
      });
      if (!tokRes.ok) throw new Error(`token: ${tokRes.statusText}`);
      const { token, url } = await tokRes.json();

      // 3. Join the loopback LiveKit room
      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
      });
      roomRef.current = room;

      room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
        if (track.kind === Track.Kind.Audio) {
          const audio = track as RemoteAudioTrack;
          if (audioElRef.current) {
            audio.attach(audioElRef.current);
          }
          // Build an AnalyserNode off the remote audio for the visualizer
          try {
            const ms = audio.mediaStreamTrack ? new MediaStream([audio.mediaStreamTrack]) : null;
            if (ms) {
              const AudioCtx = (window.AudioContext || (window as any).webkitAudioContext);
              const ctx = new AudioCtx();
              const src = ctx.createMediaStreamSource(ms);
              const analyser = ctx.createAnalyser();
              analyser.fftSize = 64;
              src.connect(analyser);
              analyserRef.current = analyser;
              const buf = new Uint8Array(analyser.frequencyBinCount);
              const tick = () => {
                if (!analyserRef.current) return;
                analyserRef.current.getByteFrequencyData(buf);
                const bars = Array.from(buf).slice(0, 24).map((v) => v / 255);
                setAgentLevel(bars);
                const avg = bars.reduce((a, b) => a + b, 0) / bars.length;
                setStatus(avg > 0.04 ? "speaking" : "listening");
                rafRef.current = requestAnimationFrame(tick);
              };
              tick();
            }
          } catch { /* visualizer is optional */ }
        }
      });

      room.on(RoomEvent.Disconnected, () => {
        setStatus("idle");
        setAgentLevel(Array(24).fill(0));
      });

      await room.connect(url, token);

      // 4. Publish the mic
      const micTrack = await createLocalAudioTrack({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });
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
    setAgentLevel(Array(24).fill(0));
  };

  const active = status !== "idle" && status !== "error";

  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-slate-900/40 border-t border-slate-800/50">
      <button
        onClick={active ? stop : start}
        disabled={status === "connecting"}
        title={active ? "Stop voice" : "Start voice"}
        className={`flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center transition-all ${
          active
            ? "bg-gradient-to-r from-[#00d9ff] to-[#4ECDC4] text-slate-950 shadow-[0_0_15px_rgba(0,217,255,0.3)]"
            : "bg-slate-700/60 text-gray-400 hover:text-white"
        }`}
      >
        {status === "connecting" ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : status === "error" ? (
          <AlertCircle className="w-4 h-4 text-red-400" />
        ) : active ? (
          <Mic className="w-4 h-4" />
        ) : (
          <MicOff className="w-4 h-4" />
        )}
      </button>

      <div className="flex-1 flex items-center gap-[2px] h-8">
        {agentLevel.map((v, i) => (
          <div
            key={i}
            className="flex-1 bg-gradient-to-t from-[#00d9ff]/30 to-[#4ECDC4] rounded-sm transition-[height] duration-75"
            style={{ height: `${Math.max(4, v * 100)}%` }}
          />
        ))}
      </div>

      <div className="flex-shrink-0 min-w-[88px] text-right">
        <span className="text-[9px] font-mono uppercase tracking-[0.2em] text-[#00d9ff]/70">
          {status === "connecting" && "Connecting"}
          {status === "listening" && "Listening"}
          {status === "speaking" && "Speaking"}
          {status === "error" && "Error"}
          {status === "idle" && "Voice Off"}
        </span>
        {error && (
          <div className="text-[8px] text-red-400/80 font-mono mt-0.5 truncate max-w-[140px]">
            {error}
          </div>
        )}
      </div>

      <audio ref={audioElRef} autoPlay hidden />
    </div>
  );
}
