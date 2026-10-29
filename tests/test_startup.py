"""One-command startup uses synthetic Telegram/Worker providers, never real credentials."""

import asyncio
import json
import os
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock, MagicMock, patch
import pytest
from telegram import User, WebhookInfo
from telegram.error import TimedOut
from k9bot.config import Config, ConfigurationError, DEFAULT_WEB_APP_URL, secret_input
from k9bot.bridge import BridgeError
from k9bot.startup import start, REQUIRED_ACTIONS

TOKEN = "123456789:TEST_ONLY_SYNTHETIC_TOKEN_NOT_A_CREDENTIAL"
SECRET = "synthetic_separate_bridge_secret_32_plus_characters"
CFG = Config(
    TOKEN,
    123456789,
    DEFAULT_WEB_APP_URL.rstrip("/"),
    DEFAULT_WEB_APP_URL.rstrip("/"),
    SECRET,
    "python",
)
EMPTY = WebhookInfo(url="", has_custom_certificate=False, pending_update_count=0)
HOOK = WebhookInfo(
    url=CFG.web_app_url + "/telegram/webhook",
    has_custom_certificate=False,
    pending_update_count=3,
    max_connections=30,
    allowed_updates=["message", "callback_query"],
)


class Provider:
    def __init__(self, mode="python", actions=None):
        self.mode = mode
        self.revision = 2
        self.active = False
        self.calls = []
        self.actions = sorted(REQUIRED_ACTIONS if actions is None else actions)
        self.close = AsyncMock()

    async def request(self, method, path, payload=None):
        self.calls.append((method, path, payload))
        if path == "/identity":
            return {
                "botId": 777,
                "ownerId": CFG.owner_id,
                "webAppUrl": CFG.web_app_url + "/",
                "bridgeActions": self.actions,
            }
        if path == "/doctor":
            return {
                "service": "K9 Post Studio",
                "schema": 4,
                "counts": {"published": 0, "scheduled": 0, "uncertain": 0},
            }
        if path == "/runtime":
            if method == "POST":
                self.mode = payload["mode"]
                self.revision += 1
            return {
                "runtime": {
                    "mode": self.mode,
                    "revision": self.revision,
                    "instance_id": None,
                    "lease_until": 0,
                },
                "active": self.active,
            }
        raise AssertionError((method, path, payload))


class Telegram:
    def __init__(self, hook=EMPTY):
        self.hook = hook
        self.deletes = 0
        self.get_me = AsyncMock(return_value=User(777, "Synthetic", True))
        self.set_webhook = AsyncMock(return_value=True)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass

    async def get_webhook_info(self):
        return self.hook

    async def delete_webhook(self, **kwargs):
        assert kwargs == {"drop_pending_updates": False}
        self.deletes += 1
        self.hook = EMPTY
        return True


def save(path, cfg=CFG):
    path.write_text(
        "\n".join(
            f"{key}={json.dumps(value)}" for key, value in cfg.environment().items()
        )
        + "\n"
    )


def dependencies(provider, telegram, *, run_banner=True):
    application = NS()
    factory = MagicMock(return_value=application)

    async def serve(config, bridge, app, *, on_started):
        assert app is application and config.runtime_mode == "python"
        if run_banner:
            on_started()

    receiver = AsyncMock(side_effect=serve)
    return (
        {
            "bot_factory": lambda _: telegram,
            "bridge_factory": lambda _: provider,
            "application_factory": factory,
            "serve_bot": receiver,
        },
        factory,
        receiver,
    )


def run_start(path, **kwargs):
    with patch.dict(os.environ, {}, clear=True):
        asyncio.run(start(path, **kwargs))


def test_first_run_wizard_saves_hidden_credentials_and_starts_without_extra_commands(
    tmp_path, capsys
):
    path = tmp_path / ".env"
    provider = Provider("cloudflare")
    telegram = Telegram()
    kwargs, factory, receiver = dependencies(provider, telegram)
    visible = iter([str(CFG.owner_id), ""])
    hidden = iter([TOKEN, SECRET])
    prompt = MagicMock(side_effect=lambda _: next(visible))
    secrets = MagicMock(side_effect=lambda _: next(hidden))
    run_start(path, prompt=prompt, hidden=secrets, **kwargs)
    assert (
        prompt.call_count == 2 and secrets.call_count == 2
    )  # No runtime/CLI setup questions.
    assert Config.from_values(__import__("dotenv").dotenv_values(path)) == CFG
    if os.name != "nt":
        assert path.stat().st_mode & 0o777 == 0o600
    factory.assert_called_once()
    receiver.assert_awaited_once()
    assert provider.mode == "python" and telegram.deletes == 0
    output = capsys.readouterr().out
    assert "K9 ADVANCED BOT" in output and "Status     : Running" in output
    assert TOKEN not in output and SECRET not in output


def test_second_run_skips_wizard_and_mode_switch_and_load_does_not_seed_environment(
    tmp_path,
):
    path = tmp_path / ".env"
    save(path)
    provider = Provider()
    telegram = Telegram()
    kwargs, _, receiver = dependencies(provider, telegram)
    prompt = MagicMock(side_effect=AssertionError("no setup question expected"))
    with patch.dict(os.environ, {}, clear=True):
        asyncio.run(start(path, prompt=prompt, hidden=prompt, **kwargs))
        assert "BOT_TOKEN" not in os.environ
    prompt.assert_not_called()
    receiver.assert_awaited_once()
    assert all(m == "GET" for m, _, _ in provider.calls)
    assert telegram.deletes == 0


def test_existing_k9_webhook_gets_one_confirmation_then_later_runs_do_not_ask(tmp_path):
    path = tmp_path / ".env"
    save(path, replace(CFG, runtime_mode="cloudflare"))
    provider = Provider("cloudflare")
    telegram = Telegram(HOOK)
    kwargs, _, receiver = dependencies(provider, telegram)
    prompt = MagicMock(return_value="SWITCH PYTHON")
    run_start(path, prompt=prompt, **kwargs)
    prompt.assert_called_once()
    assert telegram.deletes == 1 and provider.mode == "python"
    backup = json.loads((tmp_path / ".k9-webhook-backup.json").read_text())
    assert backup["maxConnections"] == 30 and backup["allowedUpdates"] == [
        "message",
        "callback_query",
    ]
    assert TOKEN not in str(backup)
    assert (
        Config.from_values(__import__("dotenv").dotenv_values(path)).runtime_mode
        == "python"
    )
    run_start(
        path,
        prompt=MagicMock(side_effect=AssertionError("must not switch again")),
        **kwargs,
    )
    assert telegram.deletes == 1 and receiver.await_count == 2


def test_declined_switch_preserves_webhook_config_and_stops_before_polling(
    tmp_path, capsys
):
    path = tmp_path / ".env"
    save(path)
    old = path.read_text()
    provider = Provider("cloudflare")
    telegram = Telegram(HOOK)
    kwargs, factory, receiver = dependencies(provider, telegram)
    with pytest.raises(ConfigurationError, match="cancelled"):
        run_start(path, prompt=lambda _: "NO", **kwargs)
    assert telegram.deletes == 0 and all(m == "GET" for m, _, _ in provider.calls)
    assert path.read_text() == old
    factory.assert_not_called()
    receiver.assert_not_awaited()
    assert "Status     : Running" not in capsys.readouterr().out


def test_other_integration_is_preserved_and_no_confirmation_offered(tmp_path):
    path = tmp_path / ".env"
    save(path)
    provider = Provider()
    telegram = Telegram(
        WebhookInfo(
            url="https://another.example/webhook",
            has_custom_certificate=False,
            pending_update_count=2,
        )
    )
    kwargs, _, receiver = dependencies(provider, telegram)
    prompt = MagicMock()
    with pytest.raises(ConfigurationError, match="another integration"):
        run_start(path, prompt=prompt, **kwargs)
    prompt.assert_not_called()
    receiver.assert_not_awaited()
    assert telegram.deletes == 0 and all(m == "GET" for m, _, _ in provider.calls)


@pytest.mark.parametrize(
    "code,hint",
    [
        ("BRIDGE_NOT_CONFIGURED", "K9_BRIDGE_SECRET"),
        ("INVALID_BRIDGE_AUTH", "clock"),
        ("INVALID_AUTH", "Mini App authentication"),
        ("BRIDGE_SCHEMA_NOT_READY", "0005"),
        ("SCHEMA_NOT_READY", "0003"),
        ("STORAGE_NOT_CONFIGURED", "binding DB"),
        ("NOT_CONFIGURED", "TELEGRAM_BOT_TOKEN"),
        ("NOT_FOUND", "deployed"),
        ("API_UNCONFIRMED", "API_BASE_URL"),
    ],
)
def test_backend_blockers_are_specific_and_preserve_settings_for_retry(
    tmp_path, capsys, code, hint
):
    path = tmp_path / ".env"
    save(path)
    old = path.read_text()
    provider = Provider()
    provider.request = AsyncMock(
        side_effect=BridgeError(
            401 if code == "INVALID_AUTH" else 503, code, "sanitized notice"
        )
    )
    telegram = Telegram(HOOK)
    kwargs, _, receiver = dependencies(provider, telegram)
    with pytest.raises(ConfigurationError, match=hint):
        run_start(path, **kwargs)
    assert path.read_text() == old
    receiver.assert_not_awaited()
    assert telegram.deletes == 0
    provider.close.assert_awaited_once()
    assert "Status     : Running" not in capsys.readouterr().out


def test_missing_backend_scopes_stop_before_switching_with_exact_missing_names(
    tmp_path,
):
    path = tmp_path / ".env"
    save(path)
    provider = Provider("cloudflare", actions=["read"])
    telegram = Telegram(HOOK)
    kwargs, _, receiver = dependencies(provider, telegram)
    with pytest.raises(ConfigurationError, match="K9_BRIDGE_ALLOWED_ACTIONS.*runtime"):
        run_start(path, **kwargs)
    receiver.assert_not_awaited()
    assert telegram.deletes == 0 and all(m == "GET" for m, _, _ in provider.calls)


def test_old_backend_without_permission_metadata_is_not_claimed_ready(tmp_path):
    path = tmp_path / ".env"
    save(path)
    provider = Provider()
    original = provider.request

    async def old(*args, **kwargs):
        value = await original(*args, **kwargs)
        if args[1] == "/identity":
            del value["bridgeActions"]
        return value

    provider.request = old
    telegram = Telegram()
    kwargs, _, receiver = dependencies(provider, telegram)
    with pytest.raises(ConfigurationError, match="permission metadata"):
        run_start(path, **kwargs)
    receiver.assert_not_awaited()


def test_identity_mismatch_prevents_all_receiver_mutations(tmp_path):
    path = tmp_path / ".env"
    save(path)
    provider = Provider()
    original = provider.request

    async def mismatch(*args, **kwargs):
        value = await original(*args, **kwargs)
        if args[1] == "/identity":
            value["botId"] = 888
        return value

    provider.request = mismatch
    telegram = Telegram(HOOK)
    kwargs, _, receiver = dependencies(provider, telegram)
    with pytest.raises(ConfigurationError, match="does not match"):
        run_start(path, **kwargs)
    receiver.assert_not_awaited()
    assert telegram.deletes == 0


def test_existing_receiver_and_incomplete_transition_are_handled_safely(tmp_path):
    path = tmp_path / ".env"
    save(path)
    provider = Provider()
    provider.active = True
    telegram = Telegram()
    kwargs, _, receiver = dependencies(provider, telegram)
    with pytest.raises(ConfigurationError, match="Another Python receiver"):
        run_start(path, **kwargs)
    receiver.assert_not_awaited()
    assert all(m == "GET" for m, _, _ in provider.calls)
    provider.active = False
    provider.mode = "transition"
    prompt = MagicMock(return_value="SWITCH PYTHON")
    run_start(path, prompt=prompt, **kwargs)
    prompt.assert_called_once()
    receiver.assert_awaited_once()
    assert telegram.deletes == 0


def test_new_running_banner_is_not_printed_before_polling_starts(tmp_path, capsys):
    path = tmp_path / ".env"
    save(path)
    kwargs, _, _ = dependencies(Provider(), Telegram())
    kwargs["serve_bot"] = AsyncMock(
        side_effect=BridgeError(409, "RECEIVER_LEASE_LOST", "Lost lease")
    )
    with pytest.raises(ConfigurationError, match="lease"):
        run_start(path, **kwargs)
    assert "Status     : Running" not in capsys.readouterr().out


@pytest.mark.parametrize(
    "where, stage",
    [
        ("initialize", "bot identity initialization"),
        ("identity", "bot/Worker identity checks"),
        ("webhook", "webhook inspection"),
    ],
)
def test_network_failure_reports_stage_and_preserves_credentials_and_receiver(
    tmp_path, capsys, where, stage
):
    path = tmp_path / ".env"
    save(path)
    old = path.read_text()
    provider = Provider("cloudflare")
    telegram = Telegram(HOOK)
    error = TimedOut(f"https://api.telegram.org/bot{TOKEN}/getMe {SECRET}")
    if where == "initialize":

        class FailedInitialization(Telegram):
            async def __aenter__(self):
                raise error

        telegram = FailedInitialization(HOOK)
    elif where == "identity":
        telegram.get_me.side_effect = error
    else:
        telegram.get_webhook_info = AsyncMock(side_effect=error)
    kwargs, _, receiver = dependencies(provider, telegram)
    with pytest.raises(ConfigurationError) as caught:
        run_start(path, **kwargs)
    message = str(caught.value)
    assert stage in message and "timed out" in message
    assert TOKEN not in message and SECRET not in message
    assert path.read_text() == old and telegram.deletes == 0
    assert all(method == "GET" for method, _, _ in provider.calls)
    receiver.assert_not_awaited()
    provider.close.assert_awaited_once()
    assert "Status     : Running" not in capsys.readouterr().out


def test_hidden_input_refuses_echo_fallback():
    import getpass, warnings

    def warn(_):
        warnings.warn("unsafe fallback", getpass.GetPassWarning)

    with patch("getpass.getpass", side_effect=warn):
        with pytest.raises(ConfigurationError, match="refusing echoed"):
            secret_input("Hidden: ")


def test_root_default_entry_runs_auto_startup_without_flags():
    import bot

    with patch("k9bot.startup.start", AsyncMock()) as startup:
        assert bot.main([]) == 0
    assert startup.call_args.args == (Path(bot.__file__).resolve().with_name(".env"),)


def test_optional_check_explains_old_backend_instead_of_requesting_new_credentials(
    capsys,
):
    import bot

    with patch.object(Config, "load", return_value=CFG), patch(
        "k9bot.runtime.check",
        AsyncMock(
            side_effect=BridgeError(
                401, "INVALID_AUTH", "Telegram authentication is required."
            )
        ),
    ):
        assert bot.main(["--check"]) == 1
    message = capsys.readouterr().err
    assert "/api/bridge" in message and "older version" in message
    assert TOKEN not in message and SECRET not in message


def test_restore_cloudflare_optional_alias_does_not_start_polling():
    import bot

    with patch.object(Config, "load", return_value=CFG), patch(
        "k9bot.runtime.switch_mode", AsyncMock()
    ) as restore, patch("k9bot.startup.start", AsyncMock()) as start:
        assert bot.main(["--restore-cloudflare"]) == 0
    assert restore.call_args.args == (CFG, "cloudflare")
    start.assert_not_awaited()


@pytest.mark.parametrize(
    "health",
    [
        {"service": "Other service", "schema": 4, "counts": {}},
        {"service": "K9 Post Studio", "schema": 3, "counts": {}},
        {"service": "K9 Post Studio", "schema": 4, "counts": {}},
    ],
)
def test_database_readiness_must_be_real_before_switching_or_running(tmp_path, health):
    path = tmp_path / ".env"
    save(path)
    provider = Provider()
    original = provider.request

    async def bad_health(*args, **kwargs):
        if args[1] == "/doctor":
            return health
        return await original(*args, **kwargs)

    provider.request = bad_health
    telegram = Telegram(HOOK)
    kwargs, _, receiver = dependencies(provider, telegram)
    with pytest.raises(ConfigurationError, match="database readiness"):
        run_start(path, **kwargs)
    receiver.assert_not_awaited()
    assert telegram.deletes == 0
