"""EchoLink platform adapter for Hermes Agent.

This adapter connects Hermes to the EchoLink custom IM server in this repo:

- inbound: EchoLink WebSocket gateway -> Hermes MessageEvent
- outbound: Hermes send() -> EchoLink HTTP /v1/messages

It intentionally keeps the protocol small and text-first for the MVP.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from dataclasses import dataclass
from typing import Any

import aiohttp

from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import (
    BasePlatformAdapter,
    MessageEvent,
    MessageType,
    SendResult,
)
from gateway.session import SessionSource

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class EchoLinkConfig:
    base_url: str
    gateway_url: str
    token: str
    bot_id: str
    bot_name: str

    @classmethod
    def from_config(cls, config: PlatformConfig) -> "EchoLinkConfig":
        extra = getattr(config, "extra", {}) or {}
        base_url = (
            os.getenv("ECHOLINK_BASE_URL")
            or extra.get("base_url")
            or "http://127.0.0.1:8787"
        ).rstrip("/")
        gateway_url = os.getenv("ECHOLINK_GATEWAY_URL") or extra.get("gateway_url")

        if not gateway_url:
            gateway_url = base_url.replace("http://", "ws://", 1).replace(
                "https://", "wss://", 1
            )
            gateway_url = f"{gateway_url}/v1/gateway/connect"

        token = os.getenv("ECHOLINK_TOKEN") or extra.get("token")
        if not token:
            raise RuntimeError("ECHOLINK_TOKEN is required for EchoLinkAdapter")

        return cls(
            base_url=base_url,
            gateway_url=gateway_url,
            token=token,
            bot_id=os.getenv("ECHOLINK_BOT_ID") or extra.get("bot_id") or "hermes",
            bot_name=os.getenv("ECHOLINK_BOT_NAME") or extra.get("bot_name") or "Hermes",
        )


class EchoLinkAdapter(BasePlatformAdapter):
    """Hermes platform adapter for the EchoLink custom IM server."""

    def __init__(self, config: PlatformConfig):
        super().__init__(config, Platform("echolink"))
        self.echolink = EchoLinkConfig.from_config(config)
        self._session: aiohttp.ClientSession | None = None
        self._gateway_task: asyncio.Task[None] | None = None

    async def connect(self) -> bool:
        self._session = aiohttp.ClientSession(
            headers={"authorization": f"Bearer {self.echolink.token}"}
        )
        self._gateway_task = asyncio.create_task(self._gateway_loop())
        self._mark_connected()
        logger.info("EchoLink adapter connected to %s", self.echolink.gateway_url)
        return True

    async def disconnect(self) -> None:
        self._mark_disconnected()

        if self._gateway_task:
            self._gateway_task.cancel()
            try:
                await self._gateway_task
            except asyncio.CancelledError:
                pass
            self._gateway_task = None

        if self._session:
            await self._session.close()
            self._session = None

        logger.info("EchoLink adapter disconnected")

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> SendResult:
        if not self._session:
            return SendResult(success=False, error="EchoLink adapter is not connected")

        if not chat_id:
            return SendResult(success=False, error="chat_id is required")

        payload = {
            "chat_id": chat_id,
            "sender_id": self.echolink.bot_id,
            "sender_name": self.echolink.bot_name,
            "text": content,
        }

        metadata = metadata or {}
        reply_to = reply_to or metadata.get("reply_to") or metadata.get("message_id")
        if reply_to:
            payload["reply_to"] = str(reply_to)

        try:
            async with self._session.post(
                f"{self.echolink.base_url}/v1/messages",
                json=payload,
                timeout=aiohttp.ClientTimeout(total=30),
            ) as response:
                body = await response.text()

                if response.status >= 400:
                    return SendResult(
                        success=False,
                        error=f"EchoLink send failed: HTTP {response.status} {body}",
                    )

                data = json.loads(body) if body else {}
                return SendResult(
                    success=True,
                    message_id=data.get("id"),
                    raw_response=data,
                )
        except Exception as exc:  # noqa: BLE001 - plugin boundary should report failures.
            logger.exception("EchoLink send failed")
            return SendResult(success=False, error=str(exc))

    def supports_draft_streaming(
        self,
        chat_type: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> bool:
        return True

    async def send_draft(
        self,
        chat_id: str,
        draft_id: int,
        content: str,
        metadata: dict[str, Any] | None = None,
    ) -> SendResult:
        if not self._session:
            return SendResult(success=False, error="EchoLink adapter is not connected")

        metadata = metadata or {}
        payload = {
            "chat_id": chat_id,
            "draft_id": draft_id,
            "sender_id": self.echolink.bot_id,
            "sender_name": self.echolink.bot_name,
            "text": content,
            "final": False,
        }

        # Include thinking/reasoning if present
        if "thinking" in metadata:
            payload["thinking"] = metadata["thinking"]
        elif "reasoning" in metadata:
            payload["thinking"] = metadata["reasoning"]

        try:
            async with self._session.post(
                f"{self.echolink.base_url}/v1/drafts",
                json=payload,
                timeout=aiohttp.ClientTimeout(total=30),
            ) as response:
                body = await response.text()

                if response.status >= 400:
                    return SendResult(
                        success=False,
                        error=f"EchoLink draft failed: HTTP {response.status} {body}",
                    )

                return SendResult(success=True, message_id=f"draft_{draft_id}")
        except Exception as exc:  # noqa: BLE001 - plugin boundary should report failures.
            logger.exception("EchoLink draft failed")
            return SendResult(success=False, error=str(exc))

    async def get_chat_info(self, chat_id: str) -> dict[str, Any]:
        return {
            "chat_id": chat_id,
            "name": chat_id,
            "type": "dm",
        }

    async def _gateway_loop(self) -> None:
        assert self._session is not None

        reconnect_delay = 1.0

        while self._running:
            try:
                async with self._session.ws_connect(
                    self._gateway_url_with_token(),
                    heartbeat=30,
                ) as ws:
                    reconnect_delay = 1.0
                    logger.info("EchoLink gateway websocket connected")

                    async for frame in ws:
                        if not self._running:
                            break

                        if frame.type == aiohttp.WSMsgType.TEXT:
                            await self._handle_gateway_text(frame.data)
                        elif frame.type == aiohttp.WSMsgType.ERROR:
                            raise RuntimeError(f"Gateway websocket error: {ws.exception()}")
            except asyncio.CancelledError:
                raise
            except Exception:
                if self._running:
                    logger.exception(
                        "EchoLink gateway disconnected; reconnecting in %.1fs",
                        reconnect_delay,
                    )
                    await asyncio.sleep(reconnect_delay)
                    reconnect_delay = min(reconnect_delay * 2, 30.0)

    async def _handle_gateway_text(self, raw: str) -> None:
        try:
            event = json.loads(raw)
        except json.JSONDecodeError:
            logger.warning("Ignoring non-JSON EchoLink gateway payload: %s", raw)
            return

        if event.get("type") == "hello":
            logger.debug("EchoLink gateway hello: %s", event)
            return

        if event.get("type") != "message.created":
            logger.debug("Ignoring unsupported EchoLink event: %s", event)
            return

        sender = event.get("sender") or {}
        if sender.get("id") == self.echolink.bot_id:
            return

        message_event = self._to_hermes_message_event(event)
        await self.handle_message(message_event)

    def _to_hermes_message_event(self, event: dict[str, Any]) -> MessageEvent:
        chat = event["chat"]
        sender = event["sender"]
        message = event["message"]

        source = SessionSource(
            platform=self.platform,
            chat_id=str(chat["id"]),
            chat_type=str(chat.get("type") or "dm"),
            user_id=str(sender["id"]),
            user_name=sender.get("name"),
            thread_id=str(chat["id"]),
            message_id=str(message["id"]),
        )

        return MessageEvent(
            text=str(message.get("text", "")),
            message_type=MessageType.TEXT,
            source=source,
            raw_message=event,
            message_id=str(message["id"]),
            reply_to_message_id=message.get("reply_to"),
        )

    def _gateway_url_with_token(self) -> str:
        separator = "&" if "?" in self.echolink.gateway_url else "?"
        return f"{self.echolink.gateway_url}{separator}token={self.echolink.token}"


def check_requirements() -> bool:
    return True


def validate_config(config: PlatformConfig) -> bool:
    extra = getattr(config, "extra", {}) or {}
    return bool(os.getenv("ECHOLINK_TOKEN", "").strip() or extra.get("token"))


def _env_enablement() -> dict[str, Any] | None:
    token = os.getenv("ECHOLINK_TOKEN", "").strip()
    if not token:
        return None

    seed: dict[str, Any] = {
        "token": token,
        "base_url": os.getenv("ECHOLINK_BASE_URL", "http://127.0.0.1:8787"),
    }

    gateway_url = os.getenv("ECHOLINK_GATEWAY_URL", "").strip()
    if gateway_url:
        seed["gateway_url"] = gateway_url

    home_channel = os.getenv("ECHOLINK_HOME_CHANNEL", "").strip()
    if home_channel:
        seed["home_channel"] = {"chat_id": home_channel, "name": "EchoLink Home"}

    return seed


def register(ctx: Any) -> None:
    """Hermes plugin entry point."""
    ctx.register_platform(
        name="echolink",
        label="EchoLink",
        adapter_factory=lambda cfg: EchoLinkAdapter(cfg),
        check_fn=check_requirements,
        validate_config=validate_config,
        required_env=["ECHOLINK_TOKEN"],
        env_enablement_fn=_env_enablement,
        cron_deliver_env_var="ECHOLINK_HOME_CHANNEL",
        allowed_users_env="ECHOLINK_ALLOWED_USERS",
        allow_all_env="ECHOLINK_ALLOW_ALL_USERS",
        install_hint="pip install aiohttp",
        max_message_length=4000,
        platform_hint=(
            "You are chatting via EchoLink, a custom lightweight IM server. "
            "EchoLink currently supports text messages and markdown-like plain text."
        ),
        emoji="",
        pii_safe=True,
    )
