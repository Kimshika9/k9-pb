"""Bridge failures use synthetic credentials and mocked HTTP; no live Telegram calls."""

import asyncio
import hashlib
import hmac
import json
import os
from email.utils import formatdate
from unittest.mock import patch

import httpx
import pytest

import bot
from k9bot.bridge import Bridge, BridgeError
from k9bot.bridge_diagnostics import diagnose_bridge
from k9bot.config import Config, ConfigurationError
from k9bot.startup import backend_notice

TOKEN = "123456789:TEST_ONLY_SYNTHETIC_TOKEN_NOT_A_CREDENTIAL"
SECRET = "synthetic_separate_bridge_secret_32_plus_characters"
OTHER = "another_synthetic_bridge_secret_32_plus_characters"
CONFIG = Config(
    TOKEN,
    987654321,
    "https://studio.example.com",
    "https://studio.example.com",
    SECRET,
    "python",
)


def saved_config(path):
    path.write_text(
        "\n".join(f"{k}={json.dumps(v)}" for k, v in CONFIG.environment().items())
    )


def identity():
    return {
        "botId": 123456789,
        "ownerId": CONFIG.owner_id,
        "webAppUrl": CONFIG.web_app_url + "/",
    }


def run_diagnostic(path, handler):
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            await diagnose_bridge(path, client=client)

    return asyncio.run(run())


def test_diagnostic_signs_exact_get_and_never_changes_config_or_receiver(
    tmp_path, capsys
):
    path = tmp_path / ".env"
    saved_config(path)
    original = path.read_bytes()
    calls = []

    def handler(request):
        calls.append(request)
        assert request.method == "GET" and request.url.path == "/api/bridge/identity"
        assert request.content == b""
        canonical = "\n".join(
            [
                request.headers["X-K9-Timestamp"],
                request.headers["X-K9-Nonce"],
                "GET",
                "/api/bridge/identity",
                hashlib.sha256(b"").hexdigest(),
            ]
        )
        assert (
            request.headers["X-K9-Signature"]
            == hmac.new(SECRET.encode(), canonical.encode(), hashlib.sha256).hexdigest()
        )
        return httpx.Response(200, json=identity())

    with patch.dict(os.environ, {}, clear=True):
        run_diagnostic(path, handler)
    output = capsys.readouterr().out
    assert "bridge HMAC accepted" in output and str(path) in output
    assert "saved .env" in output and len(calls) == 1
    assert path.read_bytes() == original
    assert SECRET not in output and TOKEN not in output


def test_exported_secret_mismatch_is_reported_without_exposing_values(tmp_path, capsys):
    path = tmp_path / ".env"
    saved_config(path)

    def handler(request):
        return httpx.Response(
            401,
            json={
                "error": {
                    "code": "INVALID_BRIDGE_AUTH",
                    "message": "Controller signature verification failed.",
                }
            },
        )

    with patch.dict(os.environ, {"K9_BRIDGE_SECRET": OTHER}, clear=True):
        with pytest.raises(ConfigurationError, match="timestamp/header formats"):
            run_diagnostic(path, handler)
        assert os.environ["K9_BRIDGE_SECRET"] == OTHER
    output = capsys.readouterr().out
    assert "MISMATCH" in output and "Updating .env alone" in output
    assert SECRET not in output and OTHER not in output and TOKEN not in output


@pytest.mark.parametrize(
    "server_date, expected",
    [(formatdate(1120, usegmt=True), 120), ("invalid", None), ("", None)],
)
def test_clock_hint_is_measured_but_never_changes_signing_or_retries(
    server_date, expected
):
    calls = []

    async def run():
        def handler(request):
            calls.append(request)
            assert request.headers["X-K9-Timestamp"] == "1000"
            return httpx.Response(
                401,
                headers={"Date": server_date},
                json={
                    "error": {
                        "code": "INVALID_BRIDGE_AUTH",
                        "message": "Controller signature is missing, malformed or expired.",
                    }
                },
            )

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            bridge = Bridge(CONFIG, client)
            with pytest.raises(BridgeError) as caught:
                await bridge.request("GET", "/identity")
            error = caught.value
            assert error.clock_skew_seconds == expected
            assert "before comparing secrets" in str(backend_notice(error))
            if expected is not None:
                assert "+120s" in str(backend_notice(error))

    with patch("k9bot.bridge.time.time", return_value=1000):
        asyncio.run(run())
    assert len(calls) == 1


def test_successful_hmac_does_not_claim_wrong_owner_identity_matches(tmp_path, capsys):
    path = tmp_path / ".env"
    saved_config(path)
    with patch.dict(os.environ, {}, clear=True):
        with pytest.raises(ConfigurationError, match="identity differs"):
            run_diagnostic(
                path,
                lambda request: httpx.Response(
                    200, json={**identity(), "ownerId": 111}
                ),
            )
    assert "identity matches" not in capsys.readouterr().out


def test_root_diagnostic_command_dispatches_without_starting_polling():
    with patch("k9bot.bridge_diagnostics.diagnose_bridge") as diagnostic, patch(
        "k9bot.startup.start"
    ) as start:
        assert bot.main(["--diagnose-bridge"]) == 0
        diagnostic.assert_awaited_once_with(
            __import__("pathlib").Path(bot.__file__).resolve().with_name(".env")
        )
        start.assert_not_called()
