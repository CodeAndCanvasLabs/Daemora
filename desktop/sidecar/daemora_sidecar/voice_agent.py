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
    subscribes to the agent's audio track, and plays it through system
    speakers using LiveKit's official MediaDevices API.

    Workaround for Tauri WKWebView WebRTC audio bug — the Python sidecar
    plays TTS audio directly so the browser doesn't have to.
    """
    import asyncio as _asyncio
    loop = _asyncio.new_event_loop()
    _asyncio.set_event_loop(loop)

    async def _main():
        try:
            from livekit import rtc
        except Exception as e:
            log.error("livekit rtc missing: %s", e)
            return

        token = _build_access_token(cfg, "local-speaker")
        ws_url = cfg.livekit_url.replace("http://", "ws://").replace("https://", "wss://")
        room = rtc.Room()

        # Official LiveKit local audio output API (uses sounddevice under the hood)
        devices = rtc.MediaDevices()
        player = devices.open_output()
        player_started = False

        async def _attach_track_and_start(track):
            nonlocal player_started
            try:
                await player.add_track(track)
                log.info("local speaker: track added, starting player")
                if not player_started:
                    player_started = True
                    await player.start()
                    log.info("local speaker: player started successfully")
            except Exception as e:
                log.error("attach/start failed: %s", e, exc_info=True)

        @room.on("track_subscribed")
        def on_subscribed(track, publication, participant):
            # Only play the agent's audio (not user mic — would echo)
            if track.kind == rtc.TrackKind.KIND_AUDIO and participant.identity == "daemora-agent":
                log.info("local speaker: agent audio track received")
                _asyncio.create_task(_attach_track_and_start(track))

        try:
            await room.connect(ws_url, token)
            log.info("local speaker: joined room as 'local-speaker'")
            while True:
                await _asyncio.sleep(3600)
        except Exception as e:
            log.error("local speaker loop: %s", e)
        finally:
            try:
                await player.stop()
            except Exception: pass
            try:
                await room.disconnect()
            except Exception: pass

    try:
        loop.run_until_complete(_main())
    except Exception as e:
        log.error("speaker thread crashed: %s", e, exc_info=True)


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
