"""Run beside a clean bot.py copy. Offline fixture hooks never ship into bot modules.

Exercises the actual python bot.py entry, private .env wizard, backend handshake,
confirmed webhook transfer and native PTB polling/owner handlers twice.
"""

import asyncio
import getpass
import json
import os
import runpy
import signal
import sys
import time
from pathlib import Path
from unittest.mock import patch
from telegram import User, WebhookInfo
from telegram.error import Conflict
from telegram.request import BaseRequest
import k9bot.startup as startup

TOKEN = "123456789:TEST_ONLY_SYNTHETIC_TOKEN_NOT_A_CREDENTIAL"
SECRET = "synthetic_separate_bridge_secret_32_plus_characters"
OWNER = 123456789
EMPTY = WebhookInfo(url="", has_custom_certificate=False, pending_update_count=0)
state = {
    "mode": "cloudflare",
    "revision": 0,
    "lease": None,
    "sends": 0,
    "deletes": 0,
    "hook": WebhookInfo(
        url="https://k9-pb.kimshikano.workers.dev/telegram/webhook",
        has_custom_certificate=False,
        pending_update_count=3,
        max_connections=40,
        allowed_updates=["message", "callback_query"],
    ),
}


class Telegram:
    def __init__(self, *args):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass

    async def get_me(self):
        return User(777, "Synthetic", True)

    async def get_webhook_info(self):
        return state["hook"]

    async def delete_webhook(self, **kwargs):
        assert kwargs == {"drop_pending_updates": False}
        state["deletes"] += 1
        state["hook"] = EMPTY
        return True


class Backend:
    def __init__(self, config):
        self.config = config

    async def close(self):
        pass

    async def request(self, method, path, payload=None):
        if path == "/identity":
            return {
                "botId": 777,
                "ownerId": OWNER,
                "webAppUrl": "https://k9-pb.kimshikano.workers.dev/",
                "bridgeActions": sorted(startup.REQUIRED_ACTIONS),
            }
        if path == "/doctor":
            return {
                "service": "K9 Post Studio",
                "schema": 4,
                "counts": {"published": 0, "scheduled": 0, "uncertain": 0},
            }
        if path == "/runtime":
            if method == "POST":
                state["mode"] = payload["mode"]
                state["revision"] += 1
            return {
                "runtime": {
                    "mode": state["mode"],
                    "revision": state["revision"],
                    "instance_id": state["lease"],
                    "lease_until": int(time.time()) + 120 if state["lease"] else 0,
                },
                "active": state["lease"] is not None,
                "leaseRemaining": 120 if state["lease"] else 0,
            }
        if path == "/runtime/lease":
            if payload["action"] == "claim":
                assert state["lease"] is None
                state["lease"] = payload["instanceId"]
            elif payload["action"] == "release":
                assert state["lease"] == payload["instanceId"]
                state["lease"] = None
            return {"runtime": {}}
        raise AssertionError(path)


class Transport(BaseRequest):
    def __init__(self):
        self.delivered = 0
        self.sent = None
        self.stopping = False

    @property
    def read_timeout(self):
        return 5

    async def initialize(self):
        self.sent = asyncio.Event()

    async def shutdown(self):
        pass

    async def do_request(self, url, method, request_data=None, **kwargs):
        name = url.rsplit("/", 1)[-1]
        params = request_data.parameters if request_data else {}
        if name == "getMe":
            result = {
                "id": 777,
                "is_bot": True,
                "first_name": "Synthetic",
                "username": "synthetic_bot",
            }
        elif name == "getWebhookInfo":
            result = {
                "url": state["hook"].url,
                "has_custom_certificate": False,
                "pending_update_count": 0,
            }
        elif name == "getUpdates":
            if self.delivered < 2:
                user = 111111111 if self.delivered == 0 else OWNER
                self.delivered += 1
                result = [
                    {
                        "update_id": self.delivered,
                        "message": {
                            "message_id": 88,
                            "date": int(time.time()),
                            "chat": {"id": user, "type": "private"},
                            "from": {
                                "id": user,
                                "is_bot": False,
                                "first_name": "Synthetic",
                            },
                            "text": "/start",
                            "entities": [
                                {"type": "bot_command", "offset": 0, "length": 6}
                            ],
                        },
                    }
                ]
            elif self.sent.is_set():
                if os.name == "posix":
                    if not self.stopping:
                        self.stopping = True
                        asyncio.get_running_loop().call_later(
                            0.03, os.kill, os.getpid(), signal.SIGINT
                        )
                    await asyncio.sleep(0.01)
                    result = []
                else:
                    raise Conflict(
                        "Offline fixture stops polling after verified owner dashboard"
                    )
            else:
                await asyncio.sleep(0.01)
                result = []
        elif name == "sendMessage":
            assert int(params["chat_id"]) == OWNER and params["parse_mode"] == "HTML"
            state["sends"] += 1
            self.sent.set()
            result = {
                "message_id": 99,
                "date": int(time.time()),
                "chat": {"id": OWNER, "type": "private"},
                "text": params["text"],
            }
        else:
            raise AssertionError("Unexpected Telegram method: " + name)
        return 200, json.dumps({"ok": True, "result": result}).encode()


original = startup.build_application


def application(config, bridge):
    app = original(config, bridge)
    transport = Transport()
    object.__setattr__(app.bot, "_request", (transport, transport))
    return app


root = Path(__file__).resolve().parent
# The copy must start clean, without borrowing a workspace .env or import path.
assert not (root / ".env").exists()
prompts = iter([str(OWNER), "", "SWITCH PYTHON"])
hidden = iter([TOKEN, SECRET])
with patch.dict(os.environ, {}, clear=True), patch.object(
    startup, "Bot", Telegram
), patch.object(startup, "Bridge", Backend), patch.object(
    startup, "build_application", application
), patch(
    "builtins.input", side_effect=lambda _: next(prompts)
), patch(
    "getpass.getpass", side_effect=lambda _: next(hidden)
):
    for iteration in range(2):
        sys.argv = ["bot.py"]
        try:
            runpy.run_path(str(root / "bot.py"), run_name="__main__")
        except SystemExit as result:
            assert result.code == 0
        assert (
            state["sends"] == iteration + 1
            and state["deletes"] == 1
            and state["lease"] is None
        )
    assert (root / ".env").stat().st_mode & 0o777 == 0o600
    assert 'BOT_RUNTIME_MODE="python"' in (root / ".env").read_text()
print(
    "Clean two-command workflow passed: first-run hidden setup/confirmed takeover/native owner dashboard; second run skipped all questions and switching; non-owner denied and leases released. No real Telegram calls."
)
