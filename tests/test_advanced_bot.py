"""Python Telegram bot tests: synthetic credentials, no external requests."""

import asyncio
import hashlib
import hmac
import json
import os
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock, patch, MagicMock
import pytest
import httpx
from telegram import WebhookInfo, User
from telegram.error import Conflict, InvalidToken
from telegram.ext import ExtBot
import bot
from k9bot.config import Config, ConfigurationError, setup
from k9bot.bridge import Bridge, BridgeError
from k9bot.menus import StudioBot
from k9bot.runtime import switch_with, FencedBot, serve, check

TOKEN = "123456789:TEST_ONLY_SYNTHETIC_TOKEN_NOT_A_CREDENTIAL"
SECRET = "synthetic_separate_bridge_secret_32_plus_characters"
PID = "12345678-1234-4234-8234-123456789012"
CID = "23456789-1234-4234-8234-123456789012"
OWNER = 123456789
CFG = Config(
    TOKEN,
    OWNER,
    "https://studio.example.com",
    "https://studio.example.com",
    SECRET,
    "python",
)
DRAFT = {
    "id": PID,
    "title": "Myanmar <studio>",
    "revision": 2,
    "document": {"version": 2, "blocks": []},
}
CHANNEL = {
    "id": CID,
    "title": "Approved channel",
    "active": 1,
    "approved_at": "2026-01-01",
}
IDENTITY = {"botId": 777, "ownerId": OWNER, "webAppUrl": "https://studio.example.com/"}
INFO = WebhookInfo(url="", has_custom_certificate=False, pending_update_count=0)


def run(awaitable):
    return asyncio.run(awaitable)


class FakeBridge:
    def __init__(self):
        self.calls = []
        self.revision = 0
        self.mode = "cloudflare"

    async def request(self, method, path, payload=None):
        self.calls.append((method, path, payload))
        if path == "/identity":
            return IDENTITY
        if path == "/runtime":
            if method == "POST":
                self.revision += 1
                self.mode = payload["mode"]
            return {
                "runtime": {
                    "mode": self.mode,
                    "revision": self.revision,
                    "instance_id": None,
                    "lease_until": 0,
                },
                "active": False,
            }
        if path == "/runtime/lease":
            return {"runtime": {}}
        if path == "/doctor":
            return {
                "counts": {"published": 1, "scheduled": 1, "uncertain": 0},
                "schema": 4,
                "schedulerEnabled": False,
            }
        if path.startswith("/drafts?"):
            return {"drafts": [DRAFT], "nextOffset": None}
        if path == "/drafts" and method == "POST":
            return {"draft": DRAFT}
        if path == "/drafts/" + PID:
            return {"draft": DRAFT}
        if path == "/channels":
            return {
                "channels": [
                    CHANNEL,
                    {
                        "id": "revoked",
                        "title": "Revoked",
                        "active": 0,
                        "approved_at": None,
                    },
                ]
            }
        if path.startswith("/publications?"):
            return {
                "publications": [{"id": "pub", "title": "Delivered"}],
                "nextOffset": None,
            }
        if path == "/publications/pub":
            return {
                "publication": {
                    "title": "Delivered",
                    "status": "published",
                    "telegram_message_id": 44,
                },
                "history": [{"action": "publication.publish"}],
            }
        if path.startswith("/scheduled?"):
            return {"jobs": [{"id": "job", "title": "Scheduled"}], "nextOffset": None}
        if path == "/scheduled/job":
            return {
                "job": {
                    "id": "job",
                    "title": "Scheduled",
                    "revision": 1,
                    "run_at": "2027-01-01T00:00:00Z",
                    "status": "pending",
                    "delivery_state": "waiting",
                    "attempts": 0,
                }
            }
        if path == "/scheduled/job/cancel":
            return {"job": {"status": "cancelled"}}
        if path == "/templates":
            return {
                "templates": [
                    {
                        "id": "sample",
                        "name": "Card",
                        "document": {"version": 2, "blocks": []},
                    }
                ]
            }
        if path.startswith("/media?"):
            return {"media": [], "nextOffset": None}
        if path == "/media/register":
            return {"media": {"id": "media"}}
        if path.endswith("/check"):
            return {
                "ready": True,
                "title": DRAFT["title"],
                "channelTitle": CHANNEL["title"],
            }
        if path.endswith("/schedule"):
            return {"job": {"id": "job"}}
        if path.startswith("/operations/"):
            return {"operation": {"id": path.split("/")[-1], "status": "succeeded"}}
        if path.endswith("/preview") or path.endswith("/publish"):
            return {"publication": {"status": "published", "telegram_message_id": 44}}
        raise AssertionError((method, path, payload))


def update(text="/start", user=OWNER, chat_type="private", query_data=None):
    message = NS(
        message_id=99, text=text, reply_text=AsyncMock(return_value=NS(message_id=99))
    )
    query = (
        NS(
            data=query_data,
            message=message,
            answer=AsyncMock(),
            edit_message_text=AsyncMock(return_value=NS(message_id=99)),
        )
        if query_data is not None
        else None
    )
    return NS(
        effective_user=NS(id=user),
        effective_chat=NS(id=user, type=chat_type),
        effective_message=message,
        callback_query=query,
    )


def markup(u):
    method = (
        u.callback_query.edit_message_text
        if u.callback_query
        else u.effective_message.reply_text
    )
    return method.call_args.kwargs["reply_markup"]


def selection(u, label):
    return next(
        b.callback_data
        for row in markup(u).inline_keyboard
        for b in row
        if b.text == label
    )


async def click(studio, u, label):
    q = update(query_data=selection(u, label))
    await studio.callback(q, None)
    return q


def test_config_loading_validates_values_and_hides_credentials(tmp_path):
    with patch.dict(os.environ, CFG.environment(), clear=True):
        assert Config.load(tmp_path / "missing.env") == CFG
    assert TOKEN not in repr(CFG) and SECRET not in repr(CFG)
    for key, value in [
        ("BOT_TOKEN", "invalid"),
        ("OWNER_ID", "00123"),
        ("OWNER_ID", "1e9"),
        ("K9_BRIDGE_SECRET", "replace_with_secret"),
        ("WEB_APP_URL", "http://public.example"),
        ("API_BASE_URL", "https://user:pass@example.com"),
        ("BOT_RUNTIME_MODE", "poll"),
    ]:
        with pytest.raises(ConfigurationError):
            Config.from_values({**CFG.environment(), key: value})


def test_setup_validates_getme_without_webhook_changes_and_writes_private_env(
    tmp_path, capsys
):
    telegram = NS(
        get_me=AsyncMock(return_value=User(777, "Synthetic", True)),
        delete_webhook=AsyncMock(),
        set_webhook=AsyncMock(),
    )
    manager = MagicMock()
    manager.__aenter__ = AsyncMock(return_value=telegram)
    manager.__aexit__ = AsyncMock(return_value=None)
    prompts = iter([str(OWNER), CFG.web_app_url, "python"])
    hidden = iter([TOKEN, SECRET])
    cfg = run(
        setup(
            tmp_path / ".env",
            prompt=lambda _: next(prompts),
            hidden=lambda _: next(hidden),
            bot_factory=lambda _: manager,
        )
    )
    assert cfg == CFG and "BOT_TOKEN=" in (tmp_path / ".env").read_text()
    if os.name != "nt":
        assert (tmp_path / ".env").stat().st_mode & 0o777 == 0o600
    assert TOKEN not in capsys.readouterr().out
    telegram.delete_webhook.assert_not_called()
    telegram.set_webhook.assert_not_called()


def test_setup_invalid_token_preserves_existing_file(tmp_path):
    path = tmp_path / ".env"
    path.write_text("KEEP=existing\n")
    telegram = NS(get_me=AsyncMock(side_effect=InvalidToken("redacted")))
    manager = MagicMock()
    manager.__aenter__ = AsyncMock(return_value=telegram)
    manager.__aexit__ = AsyncMock(return_value=None)
    prompts = iter([str(OWNER), CFG.web_app_url, "cloudflare"])
    hidden = iter([TOKEN, SECRET])
    with pytest.raises(ConfigurationError):
        run(
            setup(
                path,
                prompt=lambda _: next(prompts),
                hidden=lambda _: next(hidden),
                bot_factory=lambda _: manager,
            )
        )
    assert path.read_text() == "KEEP=existing\n"


@pytest.mark.parametrize(
    "command",
    [
        "start",
        "help",
        "studio",
        "status",
        "channels",
        "posts",
        "drafts",
        "published",
        "scheduled",
        "templates",
        "media",
        "preview",
        "publish",
        "schedule",
        "cancel",
        "settings",
    ],
)
def test_every_owner_command_has_a_working_menu(command):
    studio = StudioBot(CFG, FakeBridge())
    u = update("/" + command)
    run(studio.command(u, None))
    u.effective_message.reply_text.assert_awaited_once()
    assert markup(u).inline_keyboard


def test_real_application_registers_handlers_and_official_webapp_button():
    bridge = FakeBridge()
    app = bot.create_application(CFG, bridge)
    assert isinstance(app.bot, FencedBot) and len(app.handlers[0]) == 5
    studio = app.bot_data["studio"]
    u = update()
    run(studio.command(u, None))
    launch = next(b for row in markup(u).inline_keyboard for b in row if b.web_app)
    assert launch.web_app.url == CFG.web_app_url and launch.callback_data is None
    assert all(
        len(b.callback_data.encode()) <= 64
        for row in markup(u).inline_keyboard
        for b in row
        if b.callback_data
    )


@pytest.mark.parametrize(
    "user,chat_type", [(111111111, "private"), (OWNER, "group"), (OWNER, "supergroup")]
)
def test_commands_and_callbacks_never_expose_data_to_unauthorized_contexts(
    user, chat_type
):
    bridge = FakeBridge()
    studio = StudioBot(CFG, bridge)
    u = update(user=user, chat_type=chat_type)
    run(studio.command(u, None))
    assert not bridge.calls
    u.effective_message.reply_text.assert_not_called()
    q = update(user=user, chat_type=chat_type, query_data="k9b:bad:0")
    run(studio.callback(q, None))
    q.callback_query.answer.assert_awaited_once()
    q.callback_query.edit_message_text.assert_not_called()


def test_dashboard_navigation_back_home_and_stale_callbacks():
    async def scenario():
        studio = StudioBot(CFG, FakeBridge())
        home = update()
        await studio.command(home, None)
        old = selection(home, "POST MANAGER")
        posts = await click(studio, home, "POST MANAGER")
        drafts = await click(studio, posts, "Draft posts")
        back = await click(studio, drafts, "‹ Back")
        assert "Post Manager" in back.callback_query.edit_message_text.call_args.args[0]
        stale = update(query_data=old)
        await studio.callback(stale, None)
        assert stale.callback_query.answer.call_args.kwargs["show_alert"]
        stale.callback_query.edit_message_text.assert_not_called()

    run(scenario())


def test_publish_selection_preflight_confirmation_and_duplicate_click_protection():
    async def scenario():
        bridge = FakeBridge()
        studio = StudioBot(CFG, bridge)
        u = update("/drafts")
        await studio.command(u, None)
        draft = await click(studio, u, DRAFT["title"])
        destination = await click(studio, draft, "Publish")
        assert all(
            b.text != "Revoked"
            for row in markup(destination).inline_keyboard
            for b in row
        )
        confirm = await click(studio, destination, "Approved channel")
        assert not any(p.endswith("/publish") for _, p, _ in bridge.calls)
        assert any(p.endswith("/check") for _, p, _ in bridge.calls)
        callback = selection(confirm, "CONFIRM PUBLISH")
        sent = await click(studio, confirm, "CONFIRM PUBLISH")
        assert (
            "confirmed by Telegram"
            in sent.callback_query.edit_message_text.call_args.args[0]
        )
        duplicate = update(query_data=callback)
        await studio.callback(duplicate, None)
        calls = [p for _, p, _ in bridge.calls if p.endswith("/publish")]
        assert len(calls) == 1
        payload = next(p for _, path, p in bridge.calls if path.endswith("/publish"))
        assert payload["revision"] == 2 and payload["channelId"] == CID
        uuid_value = payload["operationId"]
        assert len(uuid_value) == 36

    run(scenario())


def test_preview_is_private_and_uncertain_publish_is_not_automatically_retried():
    async def scenario():
        bridge = FakeBridge()
        studio = StudioBot(CFG, bridge)
        u = update("/drafts")
        await studio.command(u, None)
        draft = await click(studio, u, DRAFT["title"])
        await click(studio, draft, "Send Test Preview")
        payload = next(p for _, path, p in bridge.calls if path.endswith("/preview"))
        assert "channelId" not in payload
        original = bridge.request

        async def fail(method, path, payload=None):
            if path.endswith("/publish"):
                raise BridgeError(0, "API_UNCONFIRMED", "Inspect before resending")
            return await original(method, path, payload)

        bridge.request = fail
        u = update("/drafts")
        await studio.command(u, None)
        d = await click(studio, u, DRAFT["title"])
        c = await click(studio, d, "Publish")
        confirm = await click(studio, c, "Approved channel")
        result = await click(studio, confirm, "CONFIRM PUBLISH")
        assert "Operation:" in result.callback_query.edit_message_text.call_args.args[0]
        assert not any(
            "Retry" in b.text for row in markup(result).inline_keyboard for b in row
        )

    run(scenario())


def test_create_draft_template_reuse_schedule_yangon_and_cancel_workflows():
    async def scenario():
        bridge = FakeBridge()
        studio = StudioBot(CFG, bridge)
        u = update()
        await studio.command(u, None)
        await click(studio, u, "＋ CREATE POST")
        title = update("My new title")
        await studio.text(title, None)
        body = update("မြန်မာ / English")
        await studio.text(body, None)
        assert (
            next(p for m, path, p in bridge.calls if m == "POST" and path == "/drafts")[
                "document"
            ]["blocks"][0]["text"][0]["text"]
            == "မြန်မာ / English"
        )
        u = update("/drafts")
        await studio.command(u, None)
        d = await click(studio, u, DRAFT["title"])
        c = await click(studio, d, "Schedule")
        await click(studio, c, "Approved channel")
        when = update("2030-11-01 12:00 Asia/Yangon")
        await studio.text(when, None)
        await click(studio, when, "CONFIRM SCHEDULE")
        payload = next(p for _, path, p in bridge.calls if path.endswith("/schedule"))
        assert payload["runAt"] == "2030-11-01T05:30:00.000Z"
        u = update("/scheduled")
        await studio.command(u, None)
        job = await click(studio, u, "Scheduled")
        confirm = await click(studio, job, "Cancel this schedule")
        await click(studio, confirm, "CONFIRM CANCEL")
        assert any(p.endswith("/cancel") for _, p, _ in bridge.calls)
        u = update("/templates")
        await studio.command(u, None)
        await click(studio, u, "Card")
        assert (
            len([1 for m, path, p in bridge.calls if m == "POST" and path == "/drafts"])
            == 2
        )

    run(scenario())


@pytest.mark.parametrize("kind", ["photo", "video", "document"])
def test_media_registration_is_owner_only_and_shares_canonical_metadata(kind):
    bridge = FakeBridge()
    studio = StudioBot(CFG, bridge)
    u = update()
    media = NS(
        file_id="AgAC_synthetic_python_media_123",
        file_unique_id="synthetic_unique",
        file_size=500,
        file_name="file.bin",
        mime_type="application/octet-stream",
        width=640,
        height=480,
        duration=5,
    )
    u.effective_message.photo = [media] if kind == "photo" else []
    u.effective_message.video = media if kind == "video" else None
    u.effective_message.document = media if kind == "document" else None
    run(studio.media(u, None))
    payload = bridge.calls[-1][2]
    assert payload["kind"] == kind and payload["uniqueId"] == "synthetic_unique"
    assert TOKEN not in str(payload)
    denied = update(user=111111111)
    run(studio.media(denied, None))
    assert len(bridge.calls) == 1


def test_bridge_httpx_signs_exact_utf8_requests_and_never_retries_writes():
    async def scenario():
        calls = []

        def handler(request):
            calls.append(request)
            headers = request.headers
            stamp = headers["X-K9-Timestamp"]
            nonce = headers["X-K9-Nonce"]
            check = "\n".join(
                [
                    stamp,
                    nonce,
                    request.method,
                    request.url.raw_path.decode(),
                    hashlib.sha256(request.content).hexdigest(),
                ]
            )
            assert hmac.compare_digest(
                headers["X-K9-Signature"],
                hmac.new(SECRET.encode(), check.encode(), hashlib.sha256).hexdigest(),
            )
            return httpx.Response(200, json={"ok": True})

        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler), follow_redirects=False
        ) as http:
            bridge = Bridge(CFG, http)
            assert (
                await bridge.request(
                    "POST", "/posts/" + PID + "/preview", {"text": "မြန်မာ"}
                )
            )["ok"]
            assert SECRET not in str(calls[0].headers)
        count = 0

        def fail(request):
            nonlocal count
            count += 1
            raise httpx.ReadTimeout("redacted")

        async with httpx.AsyncClient(transport=httpx.MockTransport(fail)) as http:
            with pytest.raises(BridgeError):
                await Bridge(CFG, http).request(
                    "POST", "/posts/" + PID + "/publish", {"revision": 2}
                )
        assert count == 1

    run(scenario())


def mock_telegram(info=INFO):
    return NS(
        get_me=AsyncMock(return_value=User(777, "Synthetic", True)),
        get_webhook_info=AsyncMock(return_value=info),
        delete_webhook=AsyncMock(return_value=True),
        set_webhook=AsyncMock(return_value=True),
    )


def test_mode_switch_requires_confirmation_and_preserves_backup_and_pending_updates(
    tmp_path,
):
    async def scenario():
        bridge = FakeBridge()
        old = WebhookInfo(
            url=CFG.web_app_url + "/telegram/webhook",
            has_custom_certificate=False,
            pending_update_count=3,
            max_connections=30,
            allowed_updates=["message", "callback_query"],
        )
        tg = mock_telegram(old)
        with pytest.raises(ConfigurationError):
            await switch_with(
                CFG,
                "python",
                bridge,
                tg,
                prompt=lambda _: "NO",
                backup_path=tmp_path / "backup",
            )
        assert not any(m == "POST" for m, _, _ in bridge.calls)
        tg.delete_webhook.assert_not_called()
        tg.get_webhook_info.side_effect = [old, old, INFO]
        await switch_with(
            CFG,
            "python",
            bridge,
            tg,
            prompt=lambda _: "SWITCH PYTHON",
            backup_path=tmp_path / "backup",
        )
        tg.delete_webhook.assert_awaited_once_with(drop_pending_updates=False)
        assert bridge.mode == "python"
        saved = json.loads((tmp_path / "backup").read_text())
        assert saved["maxConnections"] == 30 and TOKEN not in str(saved)
        tg.get_webhook_info.side_effect = [INFO, INFO, old]
        await switch_with(
            CFG,
            "cloudflare",
            bridge,
            tg,
            prompt=lambda _: "SWITCH CLOUDFLARE",
            hidden=lambda _: "synthetic_webhook_secret_32_characters",
            backup_path=tmp_path / "backup",
        )
        assert bridge.mode == "cloudflare"
        assert tg.set_webhook.call_args.kwargs["drop_pending_updates"] is False
        assert tg.set_webhook.call_args.kwargs["allowed_updates"] == [
            "message",
            "callback_query",
        ]

    run(scenario())


def test_custom_webhooks_and_running_receivers_block_switching(tmp_path):
    async def scenario():
        bridge = FakeBridge()
        tg = mock_telegram(
            WebhookInfo(
                url="https://another.example/webhook",
                has_custom_certificate=False,
                pending_update_count=0,
            )
        )
        with pytest.raises(ConfigurationError):
            await switch_with(
                CFG,
                "python",
                bridge,
                tg,
                prompt=lambda _: "SWITCH PYTHON",
                backup_path=tmp_path / "backup",
            )
        tg.delete_webhook.assert_not_called()
        tg = mock_telegram()
        original = bridge.request

        async def active(method, path, payload=None):
            if path == "/runtime":
                return {
                    "runtime": {"mode": "python", "revision": 2, "lease_until": 10**12}
                }
            return await original(method, path, payload)

        bridge.request = active
        with pytest.raises(ConfigurationError):
            await switch_with(
                CFG,
                "cloudflare",
                bridge,
                tg,
                prompt=lambda _: "SWITCH CLOUDFLARE",
                backup_path=tmp_path / "backup",
            )
        tg.set_webhook.assert_not_called()

    run(scenario())


def test_polling_bootstrap_never_deletes_webhooks_and_fence_loss_prevents_getupdates():
    async def scenario():
        bridge = FakeBridge()
        tg = FencedBot(CFG, bridge)
        with patch.object(
            ExtBot, "get_webhook_info", AsyncMock(return_value=INFO)
        ), patch.object(ExtBot, "delete_webhook", AsyncMock()) as delete:
            assert await tg.delete_webhook() is True
            delete.assert_not_called()
        existing = WebhookInfo(
            url=CFG.web_app_url + "/telegram/webhook",
            has_custom_certificate=False,
            pending_update_count=0,
        )
        with patch.object(
            ExtBot, "get_webhook_info", AsyncMock(return_value=existing)
        ), patch.object(ExtBot, "delete_webhook", AsyncMock()) as delete:
            with pytest.raises(ConfigurationError):
                await tg.delete_webhook()
            delete.assert_not_called()
        with patch.object(ExtBot, "get_updates", AsyncMock()) as polling:
            with pytest.raises(Conflict):
                await tg.get_updates()
            polling.assert_not_called()

    run(scenario())


def test_graceful_polling_shutdown_releases_lease_and_never_drops_updates():
    async def scenario():
        bridge = FakeBridge()
        tg = mock_telegram()
        tg.instance_id = PID
        updater = NS(running=False, start_polling=AsyncMock(), stop=AsyncMock())
        app = NS(
            bot=tg,
            initialize=AsyncMock(),
            shutdown=AsyncMock(),
            start=AsyncMock(),
            stop=AsyncMock(),
            running=False,
            updater=updater,
        )

        async def start():
            app.running = True

        async def poll(**kwargs):
            updater.running = True
            kwargs["error_callback"](Conflict("synthetic conflict"))

        app.start.side_effect = start
        updater.start_polling.side_effect = poll
        await serve(CFG, bridge, app)
        updater.stop.assert_awaited_once()
        app.stop.assert_awaited_once()
        app.shutdown.assert_awaited_once()
        assert bridge.calls[-1][2]["action"] == "release"
        assert updater.start_polling.call_args.kwargs["drop_pending_updates"] is False

    run(scenario())


def test_check_is_read_only_and_detects_webhook_conflicts():
    bridge = FakeBridge()
    bridge.mode = "python"
    tg = mock_telegram()
    manager = MagicMock()
    manager.__aenter__ = AsyncMock(return_value=tg)
    manager.__aexit__ = AsyncMock(return_value=None)
    bridge.close = AsyncMock()
    with patch("k9bot.runtime.Bot", return_value=manager), patch(
        "k9bot.runtime.Bridge", return_value=bridge
    ):
        run(check(CFG))
    assert all(m == "GET" for m, _, _ in bridge.calls)
    tg.delete_webhook.assert_not_called()
    tg.set_webhook.assert_not_called()


def test_real_ptb_application_dispatches_telegram_updates_and_callbacks():
    from telegram import Update
    from telegram.request import BaseRequest
    import time

    class TelegramTransport(BaseRequest):
        def __init__(self):
            self.calls = []

        @property
        def read_timeout(self):
            return 5

        async def initialize(self):
            pass

        async def shutdown(self):
            pass

        async def do_request(self, url, method, request_data=None, **kwargs):
            name = url.rsplit("/", 1)[-1]
            params = request_data.parameters if request_data else {}
            self.calls.append((name, params))
            result = (
                {
                    "id": 777,
                    "is_bot": True,
                    "first_name": "Synthetic",
                    "username": "synthetic_bot",
                }
                if name == "getMe"
                else (
                    True
                    if name == "answerCallbackQuery"
                    else {
                        "message_id": 99,
                        "date": int(time.time()),
                        "chat": {"id": OWNER, "type": "private"},
                        "text": params.get("text", ""),
                    }
                )
            )
            return 200, json.dumps({"ok": True, "result": result}).encode()

    async def scenario():
        bridge = FakeBridge()
        app = bot.create_application(CFG, bridge)
        transport = TelegramTransport()
        object.__setattr__(app.bot, "_request", (transport, transport))
        async with app:

            def message(user, text):
                return {
                    "message_id": 80,
                    "date": int(time.time()),
                    "chat": {"id": user, "type": "private"},
                    "from": {"id": user, "is_bot": False, "first_name": "Synthetic"},
                    "text": text,
                    "entities": [
                        {"type": "bot_command", "offset": 0, "length": len(text)}
                    ],
                }

            await app.process_update(
                Update.de_json(
                    {"update_id": 1, "message": message(111111111, "/start")}, app.bot
                )
            )
            assert not any(m == "sendMessage" for m, _ in transport.calls)
            await app.process_update(
                Update.de_json(
                    {"update_id": 2, "message": message(OWNER, "/start")}, app.bot
                )
            )
            sent = next(p for m, p in transport.calls if m == "sendMessage")
            assert sent["parse_mode"] == "HTML"
            keyboard = (
                json.loads(sent["reply_markup"])
                if isinstance(sent["reply_markup"], str)
                else sent["reply_markup"]
            )
            rows = keyboard["inline_keyboard"]
            assert rows[0][0]["web_app"]["url"] == CFG.web_app_url
            data = next(
                b["callback_data"]
                for row in rows
                for b in row
                if b["text"] == "POST MANAGER"
            )
            await app.process_update(
                Update.de_json(
                    {
                        "update_id": 3,
                        "callback_query": {
                            "id": "q1",
                            "from": {
                                "id": OWNER,
                                "is_bot": False,
                                "first_name": "Synthetic",
                            },
                            "chat_instance": "synthetic-instance",
                            "data": data,
                            "message": {
                                "message_id": 99,
                                "date": int(time.time()),
                                "chat": {"id": OWNER, "type": "private"},
                                "text": "Menu",
                            },
                        },
                    },
                    app.bot,
                )
            )
            assert any(m == "answerCallbackQuery" for m, _ in transport.calls)
            assert any(
                m == "editMessageText" and "Post Manager" in p["text"]
                for m, p in transport.calls
            )

    run(scenario())


def test_real_ptb_polling_dispatches_start_without_deleting_a_webhook():
    import time
    from telegram.request import BaseRequest

    class Transport(BaseRequest):
        def __init__(self, event):
            self.calls = []
            self.event = event
            self.delivered = False

        @property
        def read_timeout(self):
            return 5

        async def initialize(self):
            pass

        async def shutdown(self):
            pass

        async def do_request(self, url, method, request_data=None, **kwargs):
            name = url.rsplit("/", 1)[-1]
            self.calls.append(name)
            if name == "getMe":
                result = {
                    "id": 777,
                    "is_bot": True,
                    "first_name": "Synthetic",
                    "username": "synthetic_bot",
                }
            elif name == "getWebhookInfo":
                result = {
                    "url": "",
                    "has_custom_certificate": False,
                    "pending_update_count": 0,
                }
            elif name == "getUpdates":
                if not self.delivered:
                    self.delivered = True
                    result = [
                        {
                            "update_id": 88,
                            "message": {
                                "message_id": 80,
                                "date": int(time.time()),
                                "chat": {"id": OWNER, "type": "private"},
                                "from": {
                                    "id": OWNER,
                                    "is_bot": False,
                                    "first_name": "Owner",
                                },
                                "text": "/start",
                                "entities": [
                                    {"type": "bot_command", "offset": 0, "length": 6}
                                ],
                            },
                        }
                    ]
                else:
                    await asyncio.sleep(0.05)
                    result = []
            elif name == "sendMessage":
                self.event.set()
                result = {
                    "message_id": 99,
                    "date": int(time.time()),
                    "chat": {"id": OWNER, "type": "private"},
                }
            else:
                raise AssertionError("Unexpected Telegram method")
            return 200, json.dumps({"ok": True, "result": result}).encode()

    async def scenario():
        event = asyncio.Event()
        bridge = FakeBridge()
        app = bot.create_application(CFG, bridge)
        transport = Transport(event)
        object.__setattr__(app.bot, "_request", (transport, transport))
        original = bridge.request

        async def leased(method, path, payload=None):
            if path == "/runtime":
                return {
                    "runtime": {
                        "mode": "python",
                        "instance_id": app.bot.instance_id,
                        "lease_until": int(time.time()) + 120,
                    },
                    "active": True,
                    "leaseRemaining": 120,
                }
            return await original(method, path, payload)

        bridge.request = leased
        async with app:
            await app.start()
            try:
                await app.updater.start_polling(
                    timeout=20,
                    bootstrap_retries=0,
                    drop_pending_updates=False,
                    allowed_updates=["message", "callback_query"],
                )
                await asyncio.wait_for(event.wait(), 2)
            finally:
                if app.updater.running:
                    await app.updater.stop()
                if app.running:
                    await app.stop()
        assert (
            "getUpdates" in transport.calls
            and "sendMessage" in transport.calls
            and "deleteWebhook" not in transport.calls
        )

    run(scenario())


def test_uncertain_webhook_switch_stays_fenced_and_is_not_retried(tmp_path):
    async def scenario():
        bridge = FakeBridge()
        old = WebhookInfo(
            url=CFG.web_app_url + "/telegram/webhook",
            has_custom_certificate=False,
            pending_update_count=0,
        )
        tg = mock_telegram(old)
        from telegram.error import TimedOut

        tg.delete_webhook.side_effect = TimedOut("synthetic timeout")
        with pytest.raises(ConfigurationError):
            await switch_with(
                CFG,
                "python",
                bridge,
                tg,
                prompt=lambda _: "SWITCH PYTHON",
                backup_path=tmp_path / "backup",
            )
        assert bridge.mode == "transition"
        tg.delete_webhook.assert_awaited_once()
        tg.set_webhook.assert_not_called()

    run(scenario())


def test_read_retries_use_new_nonces_and_redirects_are_not_followed():
    async def scenario():
        seen = []

        def transient(request):
            seen.append(request.headers["X-K9-Nonce"])
            if len(seen) == 1:
                raise httpx.ReadTimeout("synthetic timeout")
            return httpx.Response(200, json={"ok": True})

        async with httpx.AsyncClient(
            transport=httpx.MockTransport(transient)
        ) as client:
            assert (await Bridge(CFG, client).request("GET", "/status"))["ok"]
        assert len(seen) == 2 and seen[0] != seen[1]
        calls = []

        def redirect(request):
            calls.append(request)
            return httpx.Response(
                307,
                headers={"Location": "https://another.example"},
                json={"error": {"code": "REDIRECT", "message": "refused"}},
            )

        async with httpx.AsyncClient(
            transport=httpx.MockTransport(redirect), follow_redirects=False
        ) as client:
            with pytest.raises(BridgeError):
                await Bridge(CFG, client).request(
                    "POST", "/posts/" + PID + "/preview", {}
                )
        assert len(calls) == 1

    run(scenario())


@pytest.mark.parametrize("active,remaining", [(False, 0), (True, 25)])
def test_polling_lease_checks_server_budget_even_when_client_clock_is_slow(
    active, remaining
):
    import time

    async def scenario():
        bridge = FakeBridge()
        tg = FencedBot(CFG, bridge)

        async def state(*args, **kwargs):
            return {
                "runtime": {
                    "mode": "python",
                    "instance_id": tg.instance_id,
                    "lease_until": int(time.time()) + 5,
                },
                "active": active,
                "leaseRemaining": remaining,
            }

        bridge.request = state
        with patch(
            "k9bot.runtime.time.time", return_value=int(time.time()) - 60
        ), patch.object(ExtBot, "get_updates", AsyncMock()) as native:
            with pytest.raises(Conflict):
                await tg.get_updates(timeout=20)
            native.assert_not_called()

    run(scenario())
