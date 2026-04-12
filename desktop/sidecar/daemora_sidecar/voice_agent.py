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
    daemora_llm = DaemoraLLM(cfg, session_id="voice")

    agent = Agent(
        instructions=SYSTEM_PROMPT,
    )

    session = AgentSession(
        stt=stt,
        vad=vad,
        llm=daemora_llm,
        tts=tts,
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
