"""Custom LLM plugin — pipes LiveKit Agents' LLM interface into Daemora's
/api/chat SSE. Daemora becomes the "model", tools and all.

Targets livekit-agents 1.5.x API:
  - Subclass llm.LLM, override chat() → returns LLMStream
  - Subclass llm.LLMStream, override _run() to emit ChatChunks
  - ChatChunk(id=..., delta=ChoiceDelta(content=..., role="assistant", tool_calls=[]))
"""

from __future__ import annotations

import json
import logging
import uuid
from typing import Optional

import httpx
from livekit.agents import APIConnectOptions, llm

from .voice_config import VoiceConfig

log = logging.getLogger("daemora.voice.llm")


class DaemoraLLM(llm.LLM):
    """LiveKit LLM backed by Daemora's /api/chat SSE stream.

    Each user turn becomes one Daemora task. Daemora runs its full agent
    loop (tools, memory, crew, MCP), and we surface the text:delta events
    as LLM tokens back to the voice pipeline.
    """

    def __init__(self, cfg: VoiceConfig, session_id: str = "main"):
        super().__init__()
        self._cfg = cfg
        # Voice shares the "main" session with text chat by default, so the
        # transcript + Daemora's reply stream live into the chat UI exactly
        # like typing does. Override only if you want an isolated voice
        # history (e.g. multi-user voice rooms later).
        self._session_id = session_id
        self._client = httpx.AsyncClient(timeout=120.0)

    @property
    def provider(self) -> str:
        return "daemora"

    @property
    def model(self) -> str:
        return "daemora-agent"

    async def aclose(self):
        await self._client.aclose()

    def chat(
        self,
        *,
        chat_ctx: llm.ChatContext,
        tools: list | None = None,
        conn_options: APIConnectOptions = APIConnectOptions(),
        parallel_tool_calls=None,
        tool_choice=None,
        extra_kwargs=None,
    ) -> "DaemoraLLMStream":
        # Pick the most recent user message — that's what we POST to Daemora.
        user_input = ""
        for item in reversed(list(chat_ctx.items)):
            if getattr(item, "role", None) == "user":
                content = item.content
                if isinstance(content, list):
                    user_input = " ".join(str(c) for c in content if c)
                else:
                    user_input = str(content or "")
                if user_input:
                    break
        return DaemoraLLMStream(
            llm=self,
            chat_ctx=chat_ctx,
            tools=tools or [],
            conn_options=conn_options,
            user_input=user_input,
        )


class DaemoraLLMStream(llm.LLMStream):
    def __init__(
        self,
        *,
        llm: DaemoraLLM,
        chat_ctx: llm.ChatContext,
        tools: list,
        conn_options: APIConnectOptions,
        user_input: str,
    ):
        super().__init__(llm=llm, chat_ctx=chat_ctx, tools=tools, conn_options=conn_options)
        self._user_input = user_input

    async def _run(self) -> None:
        cfg: VoiceConfig = self._llm._cfg  # type: ignore[attr-defined]
        client = self._llm._client  # type: ignore[attr-defined]
        request_id = str(uuid.uuid4())

        if not self._user_input.strip():
            log.debug("empty user input, nothing to stream")
            return

        headers = {"Content-Type": "application/json"}
        if cfg.daemora_auth_token:
            headers["Authorization"] = f"Bearer {cfg.daemora_auth_token}"

        # Send voice: true flag — Daemora appends voice instructions to the
        # system prompt at runtime, no token waste on user input.
        try:
            r = await client.post(
                f"{cfg.daemora_http}/api/chat",
                headers=headers,
                json={
                    "input": self._user_input,
                    "sessionId": self._llm._session_id,  # type: ignore[attr-defined]
                    "voice": True,
                },
            )
            r.raise_for_status()
            task_id = r.json().get("taskId")
        except Exception as e:
            log.error("Daemora /api/chat POST failed: %s", e)
            return

        if not task_id:
            log.error("Daemora returned no taskId")
            return

        # 2) Tail the task SSE stream; emit text:delta as ChatChunk
        sse_url = f"{cfg.daemora_http}/api/tasks/{task_id}/stream"
        sse_headers = dict(headers)
        sse_headers["Accept"] = "text/event-stream"

        try:
            async with client.stream("GET", sse_url, headers=sse_headers, timeout=None) as resp:
                event_name: Optional[str] = None
                async for line in resp.aiter_lines():
                    line = line.strip()
                    if not line:
                        event_name = None
                        continue
                    if line.startswith("event:"):
                        event_name = line.split(":", 1)[1].strip()
                        continue
                    if not line.startswith("data:"):
                        continue
                    data_str = line.split(":", 1)[1].strip()
                    try:
                        payload = json.loads(data_str)
                    except Exception:
                        continue

                    if event_name == "text:delta":
                        delta = payload.get("delta", "")
                        if not delta:
                            continue
                        self._event_ch.send_nowait(
                            llm.ChatChunk(
                                id=request_id,
                                delta=llm.ChoiceDelta(
                                    role="assistant",
                                    content=delta,
                                    tool_calls=[],
                                ),
                            )
                        )
                    elif event_name in ("task:completed", "task:failed", "text:end"):
                        return
        except Exception as e:
            log.error("Daemora SSE stream error: %s", e)
            return
