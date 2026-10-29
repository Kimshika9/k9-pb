"""HTTPX transport for the existing signed Worker protocol; no business logic."""

from __future__ import annotations
import asyncio
import json
import re
import time
from email.utils import parsedate_to_datetime
import httpx
from .cli import signed_headers
from .config import Config


class BridgeError(Exception):
    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        *,
        clock_skew_seconds: float | None = None,
    ):
        super().__init__(message)
        self.status, self.code = status, code
        self.clock_skew_seconds = clock_skew_seconds


class Bridge:
    def __init__(self, config: Config, client: httpx.AsyncClient | None = None):
        self.config = config
        self.client = client or httpx.AsyncClient(timeout=60, follow_redirects=False)
        self.owns_client = client is None
        self.clock_skew_seconds: float | None = None

    async def close(self):
        if self.owns_client:
            await self.client.aclose()

    async def request(
        self, method: str, path: str, payload: dict | None = None
    ) -> dict:
        if not re.fullmatch(r"/[A-Za-z0-9_/?=&%.-]+", path) or ".." in path:
            raise BridgeError(400, "INVALID_PATH", "Invalid bridge path.")
        original = "/api/bridge" + path
        body = (
            b""
            if payload is None
            else json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode(
                "utf-8"
            )
        )
        attempts = 2 if method == "GET" else 1
        for attempt in range(attempts):
            try:
                sent_at = time.time()
                async with self.client.stream(
                    method,
                    self.config.api_base_url + original,
                    headers=signed_headers(
                        self.config.bridge_secret, method, original, body
                    ),
                    content=body,
                ) as response:
                    # Diagnostic only: never adjust signatures or relax server expiry.
                    self.clock_skew_seconds = None
                    try:
                        server_date = parsedate_to_datetime(
                            response.headers.get("Date", "")
                        )
                        if server_date.tzinfo is not None:
                            self.clock_skew_seconds = (
                                server_date.timestamp() - (sent_at + time.time()) / 2
                            )
                    except (ValueError, TypeError, OverflowError):
                        pass
                    chunks, size = [], 0
                    async for chunk in response.aiter_bytes():
                        size += len(chunk)
                        if size > 2_000_000:
                            raise ValueError()
                        chunks.append(chunk)
                    if "application/json" not in response.headers.get(
                        "Content-Type", ""
                    ):
                        raise ValueError()
                    data = json.loads(b"".join(chunks))
                    if not isinstance(data, dict):
                        raise ValueError()
                    if response.status_code >= 400 or response.is_redirect:
                        detail = data.get("error", {})
                        code = (
                            detail.get("code", "API_REJECTED")
                            if isinstance(detail, dict)
                            else "API_REJECTED"
                        )
                        message = (
                            detail.get("message", "Backend rejected this request.")
                            if isinstance(detail, dict)
                            else "Backend rejected this request."
                        )
                        if not isinstance(code, str) or not re.fullmatch(
                            r"[A-Z0-9_]{1,80}", code
                        ):
                            code = "API_REJECTED"
                        if not isinstance(message, str):
                            message = "Backend rejected this request."
                        for secret in (
                            self.config.bridge_secret,
                            self.config.bot_token,
                        ):
                            message = message.replace(secret, "[redacted]")
                        raise BridgeError(
                            response.status_code,
                            code,
                            message[:1500],
                            clock_skew_seconds=self.clock_skew_seconds,
                        )
                    return data
            except (httpx.HTTPError, ValueError, UnicodeError):
                if attempt + 1 < attempts:
                    await asyncio.sleep(0.4)
                    continue
                raise BridgeError(
                    0,
                    "API_UNCONFIRMED",
                    "No valid API confirmation received. Inspect the operation status before retrying a write.",
                ) from None
            except BridgeError as error:
                if (
                    method == "GET"
                    and error.status in (502, 504)
                    and attempt + 1 < attempts
                ):
                    await asyncio.sleep(0.4)
                    continue
                raise
        raise AssertionError("unreachable")
