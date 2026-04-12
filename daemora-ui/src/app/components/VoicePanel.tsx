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
      // 0. Pre-flight mic permission check so we don't spin up the whole
      // backend (sidecar + livekit-server) just to tear it down on a
      // doomed attempt. `navigator.permissions` is available on all
      // modern browsers but returns "prompt" when the user hasn't
      // decided yet — we let those through to the native prompt below.
      try {
        const perm = await navigator.permissions.query({ name: "microphone" as PermissionName });
        if (perm.state === "denied") {
          throw new Error(
            "Mic permission is blocked in Chrome. Click the 🔒 left of the address bar → Site settings → Microphone → Allow. Then reload."
          );
        }
      } catch (permErr: any) {
        if (permErr?.message?.includes("Mic permission is blocked")) throw permErr;
        // navigator.permissions.query may throw on old browsers — fall through to native prompt
      }

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

      room.on(RoomEvent.Disconnected, (reason) => {
        console.warn("[VoicePanel] room disconnected:", reason);
        setStatus("idle");
        setAgentLevel(Array(24).fill(0));
      });
      room.on(RoomEvent.ConnectionStateChanged, (s) => {
        console.log("[VoicePanel] connection state:", s);
      });

      console.log("[VoicePanel] connecting to", url, "as", identityRef.current);
      await room.connect(url, token);
      console.log("[VoicePanel] room connected");

      // 4. Publish the mic — this is where the browser prompts for permission
      let micTrack;
      try {
        micTrack = await createLocalAudioTrack({
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        });
      } catch (micErr: any) {
        const msg = micErr?.name === "NotAllowedError"
          ? "Mic permission denied — click the 🔒 in the address bar and allow microphone."
          : micErr?.name === "NotFoundError"
          ? "No microphone found on this device."
          : `Mic error: ${micErr?.message || micErr}`;
        throw new Error(msg);
      }
      console.log("[VoicePanel] mic track created");
      localTrackRef.current = micTrack;
      await room.localParticipant.publishTrack(micTrack);
      console.log("[VoicePanel] mic track published");

      setStatus("listening");
      startingRef.current = false;
    } catch (e: any) {
      const msg = e?.message || String(e);
      console.error("[VoicePanel] start failed:", msg, e);
      setError(msg);
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

  const statusLabel = {
    idle: "Voice Off",
    connecting: "Connecting…",
    listening: "Listening",
    speaking: "Daemora speaking",
    error: "Error",
  }[status];

  const statusColor = {
    idle: "text-gray-500",
    connecting: "text-[#00d9ff]",
    listening: "text-[#00d9ff]",
    speaking: "text-[#4ECDC4]",
    error: "text-red-400",
  }[status];

  return (
    <div className="relative w-full bg-gradient-to-r from-slate-900/70 via-slate-900/50 to-slate-900/70 border-t border-slate-800/60 backdrop-blur-md">
      {/* Ambient glow while active */}
      {active && (
        <div className="pointer-events-none absolute inset-0 opacity-60 bg-[radial-gradient(ellipse_at_center,rgba(0,217,255,0.08),transparent_70%)] animate-pulse" />
      )}

      <div className="relative flex items-center gap-4 px-4 py-3 sm:px-6 max-w-6xl mx-auto">
        {/* Mic button — bigger, glowing ring when active */}
        <button
          onClick={active ? stop : start}
          disabled={status === "connecting"}
          title={active ? "Stop voice" : "Start voice"}
          aria-label={active ? "Stop voice" : "Start voice"}
          className={`group flex-shrink-0 relative w-11 h-11 sm:w-12 sm:h-12 rounded-full flex items-center justify-center transition-all duration-300 ${
            status === "error"
              ? "bg-red-500/20 border border-red-400/50 hover:bg-red-500/30"
              : active
              ? "bg-gradient-to-br from-[#00d9ff] to-[#4ECDC4] text-slate-950 shadow-[0_0_20px_rgba(0,217,255,0.5)]"
              : "bg-slate-800/80 border border-slate-700/80 text-gray-400 hover:text-white hover:border-[#00d9ff]/50 hover:shadow-[0_0_15px_rgba(0,217,255,0.3)]"
          }`}
        >
          {/* Pulse ring while listening */}
          {status === "listening" && (
            <span className="absolute inset-0 rounded-full border-2 border-[#00d9ff]/60 animate-ping" />
          )}
          {status === "connecting" ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : status === "error" ? (
            <AlertCircle className="w-5 h-5 text-red-400" />
          ) : active ? (
            <Mic className="w-5 h-5" />
          ) : (
            <MicOff className="w-5 h-5" />
          )}
        </button>

        {/* Waveform — responsive, bigger on desktop */}
        <div className="flex-1 min-w-0 flex items-center gap-[2px] h-10 sm:h-12">
          {agentLevel.map((v, i) => {
            const scaled = active ? Math.max(6, v * 100) : 6;
            return (
              <div
                key={i}
                className={`flex-1 rounded-full transition-[height,opacity] duration-100 ${
                  status === "speaking"
                    ? "bg-gradient-to-t from-[#4ECDC4] via-[#00d9ff] to-[#4ECDC4] opacity-90"
                    : status === "listening"
                    ? "bg-gradient-to-t from-[#00d9ff]/30 to-[#00d9ff]/70 opacity-60"
                    : "bg-slate-700/50 opacity-40"
                }`}
                style={{ height: `${scaled}%` }}
              />
            );
          })}
        </div>

        {/* Status label — hidden on mobile, shown on sm+ */}
        <div className="hidden sm:flex flex-shrink-0 flex-col items-end min-w-[112px]">
          <span className={`text-[10px] font-mono uppercase tracking-[0.2em] ${statusColor} transition-colors`}>
            {statusLabel}
          </span>
          {active && !error && (
            <span className="text-[8px] text-gray-600 font-mono mt-0.5 truncate max-w-[140px]">
              {identityRef.current.replace("daemora-user-", "session ")}
            </span>
          )}
          {error && (
            <span
              className="text-[9px] text-red-400/90 font-mono mt-0.5 max-w-[180px] text-right leading-tight cursor-help"
              title={error}
            >
              {error.length > 48 ? error.slice(0, 45) + "…" : error}
            </span>
          )}
        </div>
      </div>

      <audio ref={audioElRef} autoPlay hidden />
    </div>
  );
}
