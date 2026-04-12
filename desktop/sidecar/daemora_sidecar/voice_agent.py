"""LiveKit Agent — builds the voice pipeline from VoiceConfig and joins the
local loopback room as the "agent" participant.

Pipeline: mic → VAD → STT → DaemoraLLM (SSE) → TTS → speaker. LiveKit
handles turn detection, barge-in, interruption, and audio track routing.

livekit-agents 1.5.x API: Agent + AgentSession. The Agent defines
instructions/personality; the AgentSession owns the stt/tts/llm/vad
pipeline and binds to a room.

IMPORTANT: Tauri 2 on macOS uses WKWebView, which does NOT reliably play
WebRTC audio tracks. So TTS audio is ALSO played directly through system
speakers (sounddevice) — the LiveKit audio track is a backup path.
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


async def _play_agent_audio_locally(cfg: voice_config.VoiceConfig) -> None:
    """Subscribe to the agent's audio track in the LiveKit room and play it
    through system speakers via sounddevice. Workaround for WKWebView not
    reliably playing WebRTC audio on macOS.

    Runs in parallel with the agent — acts as a second participant that
    subscribes to everyone else's audio and pipes it to the speaker.
    """
    import sounddevice as sd
    import numpy as np
    from livekit import rtc

    # Join room as "local-speaker" participant
    token = _build_access_token(cfg, "local-speaker")
    ws_url = cfg.livekit_url.replace("http://", "ws://").replace("https://", "wss://")
    room = rtc.Room()

    # Audio output stream — LiveKit audio frames are typically 48000 Hz mono
    stream_ref = {"stream": None, "sr": 0}

    def ensure_stream(sample_rate: int, channels: int):
        if stream_ref["stream"] is not None and stream_ref["sr"] == sample_rate:
            return
        if stream_ref["stream"] is not None:
            try:
                stream_ref["stream"].stop()
                stream_ref["stream"].close()
            except Exception:
                pass
        try:
            s = sd.OutputStream(
                samplerate=sample_rate,
                channels=max(1, channels),
                dtype="int16",
                blocksize=0,
                latency="low",
            )
            s.start()
            stream_ref["stream"] = s
            stream_ref["sr"] = sample_rate
            log.info("local speaker stream started (sr=%d ch=%d)", sample_rate, channels)
        except Exception as e:
            log.error("local speaker stream failed: %s", e)

    async def track_audio_stream(track: rtc.Track):
        audio_stream = rtc.AudioStream(track)
        async for event in audio_stream:
            try:
                frame = event.frame
                ensure_stream(frame.sample_rate, frame.num_channels)
                s = stream_ref["stream"]
                if s is None:
                    continue
                arr = np.frombuffer(frame.data, dtype=np.int16)
                if frame.num_channels > 1:
                    arr = arr.reshape(-1, frame.num_channels)
                else:
                    arr = arr.reshape(-1, 1)
                s.write(arr)
            except Exception as e:
                log.debug("audio frame write failed: %s", e)

    @room.on("track_subscribed")
    def on_track_subscribed(track, publication, participant):
        # ONLY play the agent's audio — not the user's mic (that would echo)
        if track.kind == rtc.TrackKind.KIND_AUDIO and participant.identity == "daemora-agent":
            log.info("local speaker: subscribed to agent audio")
            asyncio.create_task(track_audio_stream(track))

    try:
        await room.connect(ws_url, token)
        log.info("local speaker: joined room as local-speaker")
        # Block until the parent task is cancelled
        while True:
            await asyncio.sleep(3600)
    except asyncio.CancelledError:
        pass
    finally:
        if stream_ref["stream"]:
            try:
                stream_ref["stream"].stop()
                stream_ref["stream"].close()
            except Exception:
                pass
        try:
            await room.disconnect()
        except Exception:
            pass
        log.info("local speaker: shut down")


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

    # Start local speaker in parallel — plays agent's audio through system speakers
    # (WKWebView in Tauri doesn't reliably play WebRTC audio on macOS)
    local_speaker_task = asyncio.create_task(_play_agent_audio_locally(cfg))

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
    await session.say("Ready.", allow_interruptions=True)

    # Block until cancelled
    try:
        while True:
            await asyncio.sleep(3600)
    except asyncio.CancelledError:
        log.info("voice: cancellation requested")
    finally:
        try:
            local_speaker_task.cancel()
        except Exception:
            pass
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
