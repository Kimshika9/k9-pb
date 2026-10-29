"""Classify Telegram failures without displaying token-bearing exception text."""

from __future__ import annotations

import socket
import ssl
import httpx
from telegram.error import (
    Conflict,
    Forbidden,
    InvalidToken,
    NetworkError,
    RetryAfter,
    TimedOut,
)


def telegram_notice(error: BaseException) -> str:
    if isinstance(error, InvalidToken):
        return "Telegram rejected BOT_TOKEN. Use python bot.py --setup to correct it privately; do not share the token."
    if isinstance(error, Conflict):
        return "Telegram update receiver conflict. Stop another polling process; an existing webhook needs the confirmed K9 switching workflow."
    if isinstance(error, RetryAfter):
        return "Telegram rate limit reached. Wait before starting again; no delivery is automatically retried."
    if isinstance(error, Forbidden):
        return "Telegram denied this operation. Check the bot's chat/channel permissions privately."

    # Walk types only, not exception messages or URL-bearing request objects.
    causes, pending, seen = [], [error], set()
    while pending and len(seen) < 32:
        cause = pending.pop()
        if id(cause) in seen:
            continue
        seen.add(id(cause))
        causes.append(cause)
        for child in (cause.__cause__, cause.__context__):
            if isinstance(child, BaseException):
                pending.append(child)
    if any(isinstance(cause, ssl.SSLError) for cause in causes):
        return "Telegram TLS/certificate verification failed. Check the device date/time and update trusted certificates/Python dependencies. Never disable TLS verification."
    if any(isinstance(cause, socket.gaierror) for cause in causes):
        return "Telegram DNS lookup failed for api.telegram.org. Check the device's DNS/network connection."
    if any(isinstance(cause, httpx.ProxyError) for cause in causes):
        return "Telegram proxy connection failed. Check the device's configured HTTP(S) proxy; no proxy credentials are displayed."
    if any(
        isinstance(cause, (TimedOut, httpx.TimeoutException, TimeoutError))
        for cause in causes
    ):
        return "Telegram request timed out. Check access to api.telegram.org, try another network or a trusted VPN if your network blocks Telegram, then rerun python bot.py."
    if isinstance(error, NetworkError):
        return "Telegram API connection failed. Check access to api.telegram.org, try Wi-Fi/mobile data or a trusted VPN if blocked, and check device proxy settings. This does not prove the token is invalid."
    return "Telegram rejected or could not complete this operation. Check the bot configuration privately; no exception URLs or credentials are displayed."
