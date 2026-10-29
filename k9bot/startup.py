"""One-command setup and startup, reusing the verified receiver and business services."""

from __future__ import annotations

import asyncio
from dataclasses import replace
from pathlib import Path
from telegram import Bot
from telegram.error import TelegramError
from .diagnostics import telegram_notice
from .bridge import Bridge, BridgeError
from .config import (
    Config,
    ConfigurationError,
    setup,
    secret_input,
    save_runtime_preference,
)
from .runtime import verify_identity, switch_with, build_application, serve

REQUIRED_ACTIONS = frozenset(
    {"read", "preview", "publish", "schedule", "cancel", "media", "create", "runtime"}
)


def running_banner() -> None:
    print("\nK9 ADVANCED BOT")
    print("━" * 22)
    for name, status in (
        ("Bot", "Connected"),
        ("Owner", "Verified"),
        ("Web Studio", "Connected"),
        ("Backend", "Ready"),
        ("Database", "Available"),
        ("Runtime", "Python"),
    ):
        print(f"{name:<10} : {status}")
    print("━" * 22)
    print("Status     : Running")
    print(
        "Ctrl+C stops Python reception. Cloudflare publishing/D1/Cron remain separate.\n"
    )


def backend_notice(error: BridgeError) -> ConfigurationError:
    hints = {
        "BRIDGE_NOT_CONFIGURED": "Worker K9_BRIDGE_SECRET is missing or invalid. Configure its encrypted runtime secret to match the private Python setting.",
        "INVALID_BRIDGE_AUTH": "Bridge authentication failed. Check the matching K9_BRIDGE_SECRET and synchronize the device clock.",
        "INVALID_AUTH": "The Python bridge request reached Telegram Mini App authentication. Check API_BASE_URL and deploy the reviewed Worker with /api/bridge handlers and the required migrations. The deployed backend may be an older version; keep your existing credentials.",
        "BRIDGE_SCOPE_DENIED": "Worker K9_BRIDGE_ALLOWED_ACTIONS does not grant the required bot access. Review and grant the intended scopes on the backend.",
        "BRIDGE_SCHEMA_NOT_READY": "The Worker needs the approved Python bridge migration 0005 on its existing D1 database.",
        "SCHEMA_NOT_READY": "The Worker needs its reviewed publishing migrations 0003 and 0004 before the advanced bot can run.",
        "STORAGE_NOT_CONFIGURED": "The Worker D1 binding DB is missing. Bind the existing k9-post-studio database; do not create a replacement.",
        "NOT_CONFIGURED": "Worker runtime configuration is incomplete. Check TELEGRAM_BOT_TOKEN, OWNER_TELEGRAM_ID and MINI_APP_URL privately.",
        "NOT_FOUND": "The requested bridge endpoint is unavailable. The existing Worker may not have the current bot bridge code deployed.",
        "API_UNCONFIRMED": "Worker connectivity could not be confirmed. Check API_BASE_URL, network access and the deployed /api/bridge endpoints.",
        "BRIDGE_RATE_LIMIT": "The backend request limit is reached. Wait until the next minute, then start again.",
        "PYTHON_RUNNING": "Another Python receiver holds the lease. Stop it gracefully, or wait for a crashed process's lease to expire.",
        "RECEIVER_LEASE_LOST": "Another receiver is active or the receiver lease expired. Stop the competing process before starting again.",
    }
    hint = hints.get(error.code, str(error))
    if error.code == "INVALID_BRIDGE_AUTH":
        if str(error) == "Controller signature verification failed.":
            hint = (
                "Worker accepted the timestamp/header formats but rejected the HMAC signature. "
                "The effective local K9_BRIDGE_SECRET may differ from the deployed runtime value. "
                "Run python bot.py --diagnose-bridge to check the actual .env path and exported overrides."
            )
        elif str(error) == "Controller signature is missing, malformed or expired.":
            hint = (
                "Worker rejected the timestamp or signature-header format before comparing secrets. "
                "Enable automatic device date/time; run python bot.py --diagnose-bridge to check clock skew."
            )
        if error.clock_skew_seconds is not None:
            hint += (
                f" TLS response clock estimate (server minus device): {error.clock_skew_seconds:+.0f}s."
                " This is diagnostic only; authentication expiry remains 60 seconds."
            )
    return ConfigurationError(
        f"Backend unavailable ({error.code}). {hint}\nCredentials are preserved. Fix the indicated setting, then retry: python bot.py"
    )


def require_capabilities(identity: dict) -> None:
    actions = identity.get("bridgeActions")
    if not isinstance(actions, list) or not all(
        isinstance(action, str) for action in actions
    ):
        raise ConfigurationError(
            "Backend permission metadata is unavailable. Deploy the reviewed current Worker bridge before starting. Credentials are preserved; retry python bot.py after setup."
        )
    missing = REQUIRED_ACTIONS - set(actions)
    if missing:
        raise ConfigurationError(
            "Backend permissions incomplete: K9_BRIDGE_ALLOWED_ACTIONS is missing "
            + ", ".join(sorted(missing))
            + ". Review and grant these intended scopes; credentials are preserved. Retry python bot.py after backend setup."
        )


async def enable_empty_receiver(bridge: Bridge, state: dict) -> None:
    """No webhook exists: record the requested Python receiver without Telegram changes."""
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
        {"mode": "python", "revision": state["revision"], "confirmed": True},
    )


async def start(
    config_path: Path,
    *,
    prompt=None,
    hidden=None,
    bot_factory=None,
    bridge_factory=None,
    application_factory=None,
    serve_bot=None,
) -> None:
    """Default startup. Injection parameters support offline QA, never env auth overrides."""
    prompt = input if prompt is None else prompt
    hidden = secret_input if hidden is None else hidden
    bot_factory = Bot if bot_factory is None else bot_factory
    bridge_factory = Bridge if bridge_factory is None else bridge_factory
    application_factory = (
        build_application if application_factory is None else application_factory
    )
    serve_bot = serve if serve_bot is None else serve_bot
    try:
        config = Config.load(config_path)
    except ConfigurationError:
        print(
            "K9 :: one-time setup is needed. Secrets will be hidden and stored privately."
        )
        config = await setup(
            config_path,
            prompt=prompt,
            hidden=hidden,
            bot_factory=bot_factory,
            choose_runtime=False,
        )
    print("K9 :: checking Telegram, owner identity and shared Worker/D1 connection...")
    bridge = bridge_factory(config)
    stage = "bot identity initialization (getMe)"
    try:
        async with bot_factory(config.bot_token) as telegram:
            stage = "bot/Worker identity checks"
            me, identity = await asyncio.gather(
                telegram.get_me(), bridge.request("GET", "/identity")
            )
            verify_identity(config, me, identity)
            require_capabilities(identity)
            stage = "webhook inspection (getWebhookInfo)"
            health, runtime, info = await asyncio.gather(
                bridge.request("GET", "/doctor"),
                bridge.request("GET", "/runtime"),
                telegram.get_webhook_info(),
            )
            if (
                health.get("service") != "K9 Post Studio"
                or health.get("schema") != 4
                or not isinstance(health.get("counts"), dict)
                or any(
                    type(health["counts"].get(key)) is not int
                    or health["counts"][key] < 0
                    for key in ("published", "scheduled", "uncertain")
                )
            ):
                raise ConfigurationError(
                    "Backend database readiness was not confirmed. Check the deployed Worker and approved migrations; saved credentials are preserved."
                )
            expected_url = config.web_app_url + "/telegram/webhook"
            if info.url and info.url != expected_url:
                raise ConfigurationError(
                    "Receiver conflict: the active webhook belongs to another integration. Nothing was changed. Inspect it privately before starting K9."
                )
            if runtime.get("active") is not False:
                raise ConfigurationError(
                    "Another Python receiver is running. Stop it gracefully or wait for its lease to expire; no settings were changed."
                )
            state = runtime["runtime"]
            if info.url or state["mode"] == "transition":
                stage = "confirmed receiver switching"
                print(
                    "K9 :: "
                    + (
                        "the K9 Cloudflare webhook is active; Python polling cannot share updates."
                        if info.url
                        else "a previous receiver switch is incomplete; explicit confirmation is needed to resume."
                    )
                )
                # The existing switch saves metadata, prompts, fences, verifies Telegram,
                # preserves pending updates, and never silently retries uncertain changes.
                await switch_with(
                    config,
                    "python",
                    bridge,
                    telegram,
                    prompt=prompt,
                    hidden=hidden,
                    backup_path=config_path.with_name(".k9-webhook-backup.json"),
                )
            elif state["mode"] == "cloudflare":
                await enable_empty_receiver(bridge, state)
            elif state["mode"] != "python":
                raise ConfigurationError(
                    "Unknown backend receiver state. Nothing was sent; inspect the backend before retrying."
                )
        config = replace(config, runtime_mode="python")
        save_runtime_preference(config_path, "python")
        application = application_factory(config, bridge)
        stage = "Python polling startup/runtime"
        await serve_bot(config, bridge, application, on_started=running_banner)
    except BridgeError as error:
        raise backend_notice(error) from None
    except TelegramError as error:
        raise ConfigurationError(
            f"Bot unavailable during {stage}: {telegram_notice(error)}\n"
            "Saved credentials are preserved. No uncertain operation was automatically retried."
        ) from None
    finally:
        await bridge.close()
