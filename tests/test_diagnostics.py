"""Transport diagnostics remain actionable without leaking credential-bearing URLs."""

import socket
import ssl
import httpx
import pytest
from telegram.error import (
    Conflict,
    Forbidden,
    InvalidToken,
    NetworkError,
    RetryAfter,
    TelegramError,
    TimedOut,
)
from k9bot.diagnostics import telegram_notice

PRIVATE = "https://api.telegram.org/bot123:PRIVATE_SYNTHETIC_TOKEN/getMe"


def transport(cause):
    error = NetworkError(PRIVATE)
    error.__cause__ = cause
    return error


@pytest.mark.parametrize(
    "error, expected",
    [
        (InvalidToken(PRIVATE), "rejected BOT_TOKEN"),
        (Conflict(PRIVATE), "receiver conflict"),
        (Forbidden(PRIVATE), "permissions"),
        (RetryAfter(10), "rate limit"),
        (TimedOut(PRIVATE), "timed out"),
        (transport(socket.gaierror(-2, PRIVATE)), "DNS lookup failed"),
        (transport(ssl.SSLCertVerificationError(1, PRIVATE)), "certificate"),
        (transport(httpx.ProxyError(PRIVATE)), "proxy connection failed"),
        (transport(httpx.ConnectTimeout(PRIVATE)), "timed out"),
        (NetworkError(PRIVATE), "does not prove the token is invalid"),
        (TelegramError(PRIVATE), "could not complete"),
    ],
)
def test_failure_category_never_displays_exception_urls(error, expected):
    message = telegram_notice(error)
    assert expected in message
    assert "PRIVATE_SYNTHETIC_TOKEN" not in message and "/getMe" not in message


def test_wrapped_cyclic_transport_cause_is_classified_without_text_or_loop():
    cause = ssl.SSLCertVerificationError(1, PRIVATE)
    wrapper = httpx.ConnectError(PRIVATE)
    wrapper.__cause__ = cause
    error = transport(wrapper)
    cause.__context__ = error
    message = telegram_notice(error)
    assert "Never disable TLS" in message and PRIVATE not in message
