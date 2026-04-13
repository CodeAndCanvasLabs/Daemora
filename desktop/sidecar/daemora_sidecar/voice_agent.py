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


def _build_access_token(
    cfg: voice_config.VoiceConfig,
    identity: str,
    attributes: dict[str, str] | None = None,
) -> str:
    """Mint a LiveKit access token using the baked-in dev credentials.

    Safe because the server binds to 127.0.0.1 only — nothing off-machine
    can reach the room anyway.

    `attributes` are set on the participant at join time. The local-speaker
    helper uses `lk.publish_on_behalf = daemora-agent` so livekit-agents'
    RoomIO skips it when auto-linking to the "user" participant.
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
    if attributes:
        payload["attributes"] = attributes
    return _jwt.encode(payload, cfg.livekit_api_secret, algorithm="HS256")


def _run_local_speaker(cfg: voice_config.VoiceConfig, stop_event) -> None:
    """Run in a background thread. Joins the LiveKit room as 'local-speaker',
    subscribes to the agent's audio track, and plays it through system
    speakers using LiveKit's official MediaDevices API.

    Workaround for Tauri WKWebView WebRTC audio bug — the Python sidecar
    plays TTS audio directly so the browser doesn't have to.

    Terminates cleanly when `stop_event` is set — avoids ghost threads that
    keep spamming AudioMixer-timeout warnings after the main session ends.
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

        # Log which output device sounddevice will target — top suspect for
        # "player started but I hear nothing" is the wrong default device.
        try:
            import sounddevice as _sd
            _default = _sd.default.device
            _out_idx = _default[1] if isinstance(_default, (tuple, list)) else _default
            _info = _sd.query_devices(_out_idx) if _out_idx is not None else None
            log.info(
                "local speaker: output device idx=%s name=%r ch=%s rate=%s",
                _out_idx,
                _info["name"] if _info else None,
                _info["max_output_channels"] if _info else None,
                _info["default_samplerate"] if _info else None,
            )
        except Exception as _e:
            log.warning("local speaker: could not query output device: %s", _e)

        token = _build_access_token(
            cfg,
            "local-speaker",
            attributes={"lk.publish_on_behalf": "daemora-agent"},
        )
        ws_url = cfg.livekit_url.replace("http://", "ws://").replace("https://", "wss://")
        room = rtc.Room()

        devices = rtc.MediaDevices()
        player = devices.open_output()
        player_started = False
        frame_stats = {"count": 0, "bytes": 0, "last_log": time.monotonic()}

        async def _attach_track_and_start(track):
            nonlocal player_started
            try:
                await player.add_track(track)
                log.info("local speaker: track %s added (kind=%s)", track.sid, track.kind)
                if not player_started:
                    player_started = True
                    await player.start()
                    log.info("local speaker: player started")
                _asyncio.create_task(_count_frames(track))
            except Exception as e:
                log.error("attach/start failed: %s", e, exc_info=True)

        async def _count_frames(track):
            """Side stream that counts TTS frames actually reaching us from
            the SFU. If these never increment, the SFU isn't routing agent
            audio to local-speaker. If they DO increment but nothing plays,
            the output device is the problem."""
            try:
                stream = rtc.AudioStream(track, sample_rate=48000, num_channels=1)
                async for ev in stream:
                    frame_stats["count"] += 1
                    try:
                        frame_stats["bytes"] += len(ev.frame.data)
                    except Exception:
                        pass
                    now = time.monotonic()
                    if now - frame_stats["last_log"] >= 2.0:
                        log.info(
                            "local speaker: last %.1fs — %d frames, %d bytes",
                            now - frame_stats["last_log"],
                            frame_stats["count"],
                            frame_stats["bytes"],
                        )
                        frame_stats["count"] = 0
                        frame_stats["bytes"] = 0
                        frame_stats["last_log"] = now
            except Exception as e:
                log.warning("frame counter ended: %s", e)

        @room.on("track_subscribed")
        def on_subscribed(track, publication, participant):
            if track.kind == rtc.TrackKind.KIND_AUDIO and participant.identity == "daemora-agent":
                log.info("local speaker: agent audio track received")
                _asyncio.create_task(_attach_track_and_start(track))

        try:
            await room.connect(ws_url, token)
            log.info("local speaker: joined room as 'local-speaker'")
            while not stop_event.is_set():
                await _asyncio.sleep(0.25)
        except Exception as e:
            log.error("local speaker loop: %s", e, exc_info=True)
        finally:
            log.info("local speaker: shutting down")
            try:
                await player.aclose()
            except Exception as e:
                log.warning("player.aclose error: %s", e)
            try:
                await room.disconnect()
            except Exception as e:
                log.warning("room.disconnect error: %s", e)

    try:
        loop.run_until_complete(_main())
    except Exception as e:
        log.error("speaker thread crashed: %s", e, exc_info=True)
    finally:
        try:
            loop.close()
        except Exception:
            pass


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

    # Workaround for Tauri+WKWebView on macOS: the WKWebView can't reliably
    # play the agent's WebRTC audio track, so the sidecar plays it through
    # system speakers. Regular browsers (Chrome/Safari/Firefox) play the
    # track natively — enabling this there would double-play as echo.
    # Opt-in via DAEMORA_LOCAL_SPEAKER=1, set by the Tauri supervisor only.
    import os as _os
    speaker_stop = None
    speaker_thread = None
    if _os.environ.get("DAEMORA_LOCAL_SPEAKER", "").lower() in ("1", "true", "yes"):
        import threading
        speaker_stop = threading.Event()
        speaker_thread = threading.Thread(
            target=_run_local_speaker,
            args=(cfg, speaker_stop),
            daemon=True,
            name="local-speaker",
        )
        speaker_thread.start()
        log.info("local speaker thread started (WKWebView audio workaround)")
    else:
        log.info("local speaker disabled (browser handles audio natively)")

    await session.say("Ready.", allow_interruptions=True)

    # Block until cancelled
    try:
        while True:
            await asyncio.sleep(3600)
    except asyncio.CancelledError:
        log.info("voice: cancellation requested")
    finally:
        if speaker_stop is not None:
            speaker_stop.set()
            speaker_thread.join(timeout=2.0)
            if speaker_thread.is_alive():
                log.warning("voice: speaker thread did not exit within 2s — orphaned")
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
