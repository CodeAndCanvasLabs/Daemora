"""LiveKit Agent — builds the voice pipeline from VoiceConfig and joins the
local loopback room as the "agent" participant.

Pipeline: mic → VAD → STT → DaemoraLLM (SSE) → TTS → speaker. LiveKit
handles turn detection, barge-in, interruption, and audio track routing.

livekit-agents 1.5.x API: Agent + AgentSession. The Agent defines
instructions/personality; the AgentSession owns the stt/tts/llm/vad
pipeline and binds to a room.
"""

from __future__ import annotations

import asyncio
import logging
import time

from livekit import rtc
from livekit.agents import llm
from livekit.agents.voice import Agent, AgentSession

from . import voice_config, voice_providers
from .daemora_llm import DaemoraLLM

log = logging.getLogger("daemora.voice.agent")


SYSTEM_PROMPT = (
    "You are Daemora in voice mode. Keep responses short and spoken — "
    "no markdown, no code blocks, no bullet lists. Use plain sentences. "
    "Speak a brief acknowledgement before any slow tool call so the user "
    "never hears silence for more than a second."
)


def _build_access_token(cfg: voice_config.VoiceConfig, identity: str) -> str:
    """Mint a LiveKit access token using the baked-in dev credentials.

    Safe because the server binds to 127.0.0.1 only — nothing off-machine
    can reach the room anyway.
    """
    import jwt as _jwt

    now = int(time.time())
    payload = {
        "iss": cfg.livekit_api_key,
        "nbf": now,
        "exp": now + 6 * 60 * 60,
        "sub": identity,
        "video": {
            "room": cfg.room_name,
            "roomJoin": True,
            "canPublish": True,
            "canSubscribe": True,
            "canPublishData": True,
            "canUpdateOwnMetadata": True,
        },
    }
    return _jwt.encode(payload, cfg.livekit_api_secret, algorithm="HS256")


def _run_local_speaker(cfg: voice_config.VoiceConfig) -> None:
    """Run in a background thread. Joins the LiveKit room as 'local-speaker',
    subscribes to the agent's audio track, and plays frames through system
    speakers via sounddevice. Workaround for Tauri WKWebView WebRTC audio bug.
    """
    import asyncio as _asyncio
    loop = _asyncio.new_event_loop()
    _asyncio.set_event_loop(loop)

    async def _main():
        try:
            import numpy as np
            import sounddevice as sd
            from livekit import rtc
        except Exception as e:
            log.error("local speaker deps missing: %s", e)
            return

        token = _build_access_token(cfg, "local-speaker")
        ws_url = cfg.livekit_url.replace("http://", "ws://").replace("https://", "wss://")
        room = rtc.Room()

        state = {"stream": None, "sr": 0}

        def ensure_stream(sr: int, ch: int):
            if state["stream"] is not None and state["sr"] == sr:
                return
            if state["stream"] is not None:
                try: state["stream"].stop(); state["stream"].close()
                except Exception: pass
            try:
                s = sd.OutputStream(samplerate=sr, channels=max(1, ch), dtype="int16", blocksize=0, latency="low")
                s.start()
                state["stream"] = s
                state["sr"] = sr
                log.info("speaker stream: %d Hz, %d ch", sr, ch)
            except Exception as e:
                log.error("speaker stream failed: %s", e)

        async def play_track(track):
            try:
                stream = rtc.AudioStream(track)
                async for event in stream:
                    try:
                        frame = event.frame
                        ensure_stream(frame.sample_rate, frame.num_channels)
                        s = state["stream"]
                        if s is None:
                            continue
                        arr = np.frombuffer(frame.data, dtype=np.int16)
                        if frame.num_channels > 1:
                            arr = arr.reshape(-1, frame.num_channels)
                        else:
                            arr = arr.reshape(-1, 1)
                        s.write(arr)
                    except Exception as e:
                        log.debug("frame write failed: %s", e)
            except Exception as e:
                log.error("audio stream loop failed: %s", e)

        @room.on("track_subscribed")
        def on_subscribed(track, publication, participant):
            # Only play the agent's audio, not the user's mic (would echo)
            if track.kind == rtc.TrackKind.KIND_AUDIO and participant.identity == "daemora-agent":
                log.info("local speaker: subscribing to agent audio")
                _asyncio.create_task(play_track(track))

        try:
            await room.connect(ws_url, token)
            log.info("local speaker: joined room")
            while True:
                await _asyncio.sleep(3600)
        except Exception as e:
            log.error("local speaker loop: %s", e)
        finally:
            try:
                if state["stream"]:
                    state["stream"].stop()
                    state["stream"].close()
            except Exception: pass
            try:
                await room.disconnect()
            except Exception: pass

    try:
        loop.run_until_complete(_main())
    except Exception as e:
        log.error("speaker thread crashed: %s", e)


async def entrypoint_standalone() -> None:
    """Run the voice pipeline without the LiveKit Agents CLI worker.

    Called from main.py's POST /voice/start. Joins the local room
    directly and blocks until cancelled.
    """
    cfg = voice_config.load()
    log.info(
        "voice: starting (stt=%s tts=%s room=%s)",
        cfg.stt_provider, cfg.tts_provider, cfg.room_name,
    )

    ws_url = cfg.livekit_url.replace("http://", "ws://").replace("https://", "wss://")
    token = _build_access_token(cfg, "daemora-agent")

    room = rtc.Room()
    await room.connect(ws_url, token)
    log.info("voice: joined room %s", cfg.room_name)

    # Build the stack
    vad = voice_providers.build_vad()
    stt = voice_providers.build_stt(cfg)
    tts = voice_providers.build_tts(cfg)
    daemora_llm = DaemoraLLM(cfg, session_id="main")

    agent = Agent(
        instructions=SYSTEM_PROMPT,
    )

    session = AgentSession(
        stt=stt,
        vad=vad,
        llm=daemora_llm,
        tts=tts,
        user_away_timeout=None,
    )
    await session.start(agent=agent, room=room)

    # Workaround for Tauri+WKWebView on macOS: the browser can't reliably play
    # the agent's WebRTC audio track. Play it directly through system speakers
    # by subscribing to the agent's audio track from within the sidecar.
    import threading
    speaker_thread = threading.Thread(
        target=_run_local_speaker,
        args=(cfg,),
        daemon=True,
        name="local-speaker",
    )
    speaker_thread.start()
    log.info("local speaker thread started (plays TTS via system speakers)")

    await session.say("Ready.", allow_interruptions=True)

    # Block until cancelled
    try:
        while True:
            await asyncio.sleep(3600)
    except asyncio.CancelledError:
        log.info("voice: cancellation requested")
    finally:
        try:
            await session.aclose()
        except Exception:
            pass
        try:
            await daemora_llm.aclose()
        except Exception:
            pass
        try:
            await room.disconnect()
        except Exception:
            pass
        log.info("voice: shut down cleanly")
