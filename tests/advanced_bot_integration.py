"""Explicit local workerd integration; never targets a real bot or production."""

import asyncio
import json
from pathlib import Path
import sys
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from k9bot.config import Config
from k9bot.bridge import Bridge
from k9bot.menus import StudioBot
import httpx
from datetime import datetime, timedelta, timezone

TOKEN = "123456789:TEST_ONLY_SYNTHETIC_TOKEN_NOT_A_CREDENTIAL"
OWNER = 123456789
CHANNEL = "23456789-1234-4234-8234-123456789012"
CONFIG = Config(
    TOKEN,
    OWNER,
    "https://studio.example.com",
    "http://127.0.0.1:5180",
    "synthetic_separate_bridge_secret_32_plus_characters",
    "python",
)


async def main():
    bridge = Bridge(CONFIG)
    try:
        identity = await bridge.request("GET", "/identity")
        assert identity["ownerId"] == OWNER and identity["botId"] == 777
        await bridge.request("GET", "/doctor")
        created = await bridge.request(
            "POST",
            "/drafts",
            {
                "title": "Python integration draft",
                "document": {
                    "version": 2,
                    "blocks": [
                        {
                            "id": "34567890-1234-4234-8234-123456789012",
                            "type": "paragraph",
                            "text": [
                                {"text": "မြန်မာ / shared Worker post", "marks": []}
                            ],
                        }
                    ],
                },
            },
        )
        draft = created["draft"]
        pid = draft["id"]
        rev = draft["revision"]
        assert any(
            p["id"] == pid for p in (await bridge.request("GET", "/drafts"))["drafts"]
        )
        update = NS(
            effective_user=NS(id=OWNER),
            effective_chat=NS(id=OWNER, type="private"),
            effective_message=NS(
                message_id=99, reply_text=AsyncMock(return_value=NS(message_id=99))
            ),
            callback_query=None,
        )
        studio = StudioBot(CONFIG, bridge)
        await studio.dispatch(update, "draft", {"id": pid})
        await bridge.request(
            "POST", f"/posts/{pid}/check", {"revision": rev, "channelId": CHANNEL}
        )
        import uuid

        op = str(uuid.uuid4())
        await studio.dispatch(
            update,
            "publish",
            {"id": pid, "revision": rev, "channelId": CHANNEL, "operationId": op},
        )
        receipt = await bridge.request("GET", "/operations/" + op)
        assert receipt["operation"]["status"] == "succeeded"
        pubs = (await bridge.request("GET", "/publications"))["publications"]
        assert any(p["post_id"] == pid and p["telegram_message_id"] for p in pubs)
        await studio.dispatch(
            update,
            "preview",
            {"id": pid, "revision": rev, "operationId": str(uuid.uuid4())},
        )
        await bridge.request(
            "POST",
            "/media/register",
            {
                "fileId": "AgAC_synthetic_bridge_integration_media_123",
                "uniqueId": "synthetic_media_unique",
                "kind": "photo",
                "name": "Integration photo",
                "width": 640,
                "height": 480,
            },
        )
        assert any(
            m["original_name"] == "Integration photo"
            for m in (await bridge.request("GET", "/media"))["media"]
        )
        scheduled = await bridge.request(
            "POST",
            f"/posts/{pid}/schedule",
            {
                "operationId": str(uuid.uuid4()),
                "revision": rev,
                "channelId": CHANNEL,
                "runAt": (datetime.now(timezone.utc) + timedelta(days=1))
                .isoformat(timespec="milliseconds")
                .replace("+00:00", "Z"),
                "timezone": "UTC",
            },
        )
        job = scheduled["job"]
        assert (await bridge.request("GET", "/scheduled/" + job["id"]))["job"][
            "status"
        ] == "pending"
        await bridge.request(
            "POST",
            "/scheduled/" + job["id"] + "/cancel",
            {"operationId": str(uuid.uuid4()), "revision": job["revision"]},
        )
        state = (await bridge.request("GET", "/runtime"))["runtime"]
        state = (
            await bridge.request(
                "POST",
                "/runtime",
                {
                    "mode": "transition",
                    "revision": state["revision"],
                    "confirmed": True,
                },
            )
        )["runtime"]
        state = (
            await bridge.request(
                "POST",
                "/runtime",
                {"mode": "python", "revision": state["revision"], "confirmed": True},
            )
        )["runtime"]
        instance = str(uuid.uuid4())
        await bridge.request(
            "POST", "/runtime/lease", {"instanceId": instance, "action": "claim"}
        )
        await bridge.request(
            "POST", "/runtime/lease", {"instanceId": instance, "action": "heartbeat"}
        )
        await bridge.request(
            "POST", "/runtime/lease", {"instanceId": instance, "action": "release"}
        )
        state = (
            await bridge.request(
                "POST",
                "/runtime",
                {
                    "mode": "transition",
                    "revision": state["revision"],
                    "confirmed": True,
                },
            )
        )["runtime"]
        await bridge.request(
            "POST",
            "/runtime",
            {"mode": "cloudflare", "revision": state["revision"], "confirmed": True},
        )
        # A captured signature cannot be replayed, even with the same body.
        from k9bot.cli import signed_headers

        path = "/api/bridge/runtime"
        headers = signed_headers(CONFIG.bridge_secret, "GET", path, b"")
        async with httpx.AsyncClient() as client:
            assert (
                await client.get(CONFIG.api_base_url + path, headers=headers)
            ).status_code == 200
            assert (
                await client.get(CONFIG.api_base_url + path, headers=headers)
            ).status_code == 401
        # New default startup validates real bridge permissions/SQL health and records
        # Python reception automatically when no webhook exists. Telegram remains mocked.
        from k9bot.startup import start as auto_start
        from tempfile import TemporaryDirectory
        from unittest.mock import patch
        import os
        from telegram import User, WebhookInfo

        class StartupTelegram:
            def __init__(self, *args):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                pass

            async def get_me(self):
                return User(777, "Synthetic", True)

            async def get_webhook_info(self):
                return WebhookInfo(
                    url="", has_custom_certificate=False, pending_update_count=0
                )

        async def started(config, client, application, *, on_started):
            assert len(application.handlers[0]) == 5
            assert (await client.request("GET", "/runtime"))["runtime"][
                "mode"
            ] == "python"
            on_started()

        with TemporaryDirectory(prefix="k9-startup-integration-") as folder, patch.dict(
            os.environ, {}, clear=True
        ):
            path = Path(folder) / ".env"
            path.write_text(
                "\n".join(
                    f"{key}={json.dumps(value)}"
                    for key, value in CONFIG.environment().items()
                )
            )
            await auto_start(path, bot_factory=StartupTelegram, serve_bot=started)
            assert 'BOT_RUNTIME_MODE="python"' in path.read_text()
        print(
            "Actual local workerd/D1 + HTTPX bot bridge passed: shared drafts, publication receipts/history, private preview, media, schedule/cancel, receiver fence/lease, replay rejection and default startup. All Telegram sends were mocked."
        )
    finally:
        await bridge.close()


if __name__ == "__main__":
    asyncio.run(main())
