"""Explicit receiver control, polling lifecycle and safe Cloudflare restoration."""

from __future__ import annotations
import asyncio
import getpass
import json
import re
import signal
import time
import uuid
from pathlib import Path
from telegram import Bot
from telegram.ext import Application, ExtBot
from telegram.error import TelegramError, Conflict, InvalidToken
from .diagnostics import telegram_notice
from .bridge import Bridge, BridgeError
from .config import Config, ConfigurationError, private_write, secret_input


async def identities(config: Config, bridge: Bridge, telegram: Bot):
    me, identity = await asyncio.gather(
        telegram.get_me(), bridge.request("GET", "/identity")
    )
    verify_identity(config, me, identity)
    return me


def verify_identity(config: Config, me, identity: dict) -> None:
    if (
        not me.is_bot
        or me.id != identity.get("botId")
        or config.owner_id != identity.get("ownerId")
        or config.web_app_url != str(identity.get("webAppUrl", "")).rstrip("/")
    ):
        raise ConfigurationError(
            "The Python token or owner does not match the Worker. No receiver was changed."
        )


async def diagnose(config: Config, bridge: Bridge, telegram: Bot) -> dict:
    await identities(config, bridge, telegram)
    info, state, health = await asyncio.gather(
        telegram.get_webhook_info(),
        bridge.request("GET", "/runtime"),
        bridge.request("GET", "/doctor"),
    )
    return {
        "info": info,
        "runtime": state["runtime"],
        "active": state["active"],
        "health": health,
    }


async def check(config: Config):
    bridge = Bridge(config)
    try:
        async with Bot(config.bot_token) as telegram:
            result = await diagnose(config, bridge, telegram)
        print("K9 :: Telegram bot and owner match the authenticated Worker.")
        print("K9 :: backend storage and signed bridge verified.")
        print("K9 :: receiver mode: " + result["runtime"]["mode"])
        print(
            "K9 :: Python receiver lease " + ("active" if result["active"] else "idle")
        )
        print(
            "K9 :: webhook "
            + (
                "matches Cloudflare"
                if result["info"].url == config.web_app_url + "/telegram/webhook"
                else (
                    "absent" if not result["info"].url else "differs; inspect privately"
                )
            )
        )
        print(
            "K9 :: scheduler "
            + ("enabled" if result["health"]["schedulerEnabled"] else "disabled")
        )
        if result["runtime"]["mode"] != config.runtime_mode:
            raise ConfigurationError(
                "Local runtime and backend fence differ. Use --switch-mode with explicit confirmation; --check changed no webhook."
            )
        if config.runtime_mode == "python" and result["info"].url:
            raise ConfigurationError(
                "A webhook exists. Python polling is blocked until an explicitly confirmed switch."
            )
        if (
            config.runtime_mode == "cloudflare"
            and result["info"].url != config.web_app_url + "/telegram/webhook"
        ):
            raise ConfigurationError(
                "Cloudflare webhook is not confirmed. Inspect or restore it with an approved --switch-mode cloudflare."
            )
    except TelegramError as error:
        raise ConfigurationError(
            f"Telegram diagnostics failed: {telegram_notice(error)} No webhook was changed."
        ) from None
    finally:
        await bridge.close()


def webhook_backup(info, bot_id: int) -> dict:
    if info.has_custom_certificate:
        raise ConfigurationError(
            "Custom webhook certificates cannot be recovered from getWebhookInfo. Arrange a verified manual backup before switching."
        )
    return {
        "botId": bot_id,
        "url": info.url,
        "maxConnections": info.max_connections or 40,
        "allowedUpdates": (
            list(info.allowed_updates) if info.allowed_updates is not None else []
        ),
        "ipAddress": info.ip_address,
        "savedAt": int(time.time()),
    }


async def switch_with(
    config: Config,
    target: str,
    bridge: Bridge,
    telegram: Bot,
    *,
    prompt=input,
    hidden=secret_input,
    backup_path=Path(".k9-webhook-backup.json"),
):
    me = await identities(config, bridge, telegram)
    info = await telegram.get_webhook_info()
    runtime = await bridge.request("GET", "/runtime")
    state = runtime["runtime"]
    if runtime.get("active") is not False:
        raise ConfigurationError(
            "A Python receiver is running. Stop it gracefully before switching."
        )
    expected_url = config.web_app_url + "/telegram/webhook"
    if info.url and info.url != expected_url:
        raise ConfigurationError(
            "Existing webhook differs from the configured Cloudflare endpoint. Inspect privately; switching is blocked to preserve another integration."
        )
    if target == "python":
        backup = webhook_backup(info, me.id)
        # Preserve the original backup across interrupted switches and repeated checks.
        if info.url:
            backup_text = json.dumps(backup, indent=2)
        else:
            backup_text = None
        print(
            "K9 :: Python will take over updates. The Worker receiver will pause; this Python process must stay running. Pending updates will be preserved."
        )
    else:
        backup = (
            json.loads(backup_path.read_text("utf-8"))
            if backup_path.exists()
            else {
                "botId": me.id,
                "url": expected_url,
                "maxConnections": 40,
                "allowedUpdates": ["message", "callback_query"],
            }
        )
        if backup.get("botId") != me.id or backup.get("url") not in ("", expected_url):
            raise ConfigurationError(
                "Webhook backup does not match this bot and Cloudflare URL."
            )
        print(
            "K9 :: Cloudflare will regain updates. Python polling must remain stopped. Existing pending updates will not be dropped."
        )
    if (
        prompt(f"Type SWITCH {target.upper()} to approve this receiver change: ")
        != f"SWITCH {target.upper()}"
    ):
        raise ConfigurationError(
            "Mode switch cancelled. No webhook or backend receiver setting changed."
        )
    secret = None
    if target == "cloudflare":
        secret = hidden(
            "Existing Worker TELEGRAM_WEBHOOK_SECRET (hidden; not recoverable from Telegram): "
        )
        if not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", secret):
            raise ConfigurationError(
                "Use the existing valid Worker webhook secret. No change was made."
            )
    elif backup_text is not None:
        private_write(backup_path, backup_text)
    if state["mode"] != "transition":
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
    try:
        # Verify again after fencing; a competing external operator must not be overwritten.
        current = await telegram.get_webhook_info()
        if current.url and current.url != expected_url:
            raise ConfigurationError(
                "Webhook changed concurrently. Both receivers remain fenced; inspect before resuming."
            )
        if target == "python":
            if current.url:
                if (
                    await telegram.delete_webhook(drop_pending_updates=False)
                    is not True
                ):
                    raise ConfigurationError(
                        "Telegram did not confirm webhook removal; inspect before proceeding."
                    )
            if (await telegram.get_webhook_info()).url:
                raise ConfigurationError(
                    "Webhook removal was not verified; polling remains blocked."
                )
        else:
            if (
                await telegram.set_webhook(
                    url=expected_url,
                    secret_token=secret,
                    max_connections=backup["maxConnections"],
                    allowed_updates=backup["allowedUpdates"],
                    drop_pending_updates=False,
                )
                is not True
            ):
                raise ConfigurationError(
                    "Telegram did not confirm webhook restoration."
                )
            if (await telegram.get_webhook_info()).url != expected_url:
                raise ConfigurationError("Webhook restoration was not verified.")
        await bridge.request(
            "POST",
            "/runtime",
            {"mode": target, "revision": state["revision"], "confirmed": True},
        )
    except (TelegramError, BridgeError):
        raise ConfigurationError(
            "Switch outcome needs inspection. Receivers remain fenced if completion was not recorded. Use --check; never silently retry uncertain Telegram changes."
        ) from None
    print(f"K9 :: {target} receiver confirmed.")


async def switch_mode(config: Config, target: str, *, config_path: Path = Path(".env")):
    bridge = Bridge(config)
    try:
        async with Bot(config.bot_token) as telegram:
            await switch_with(
                config,
                target,
                bridge,
                telegram,
                backup_path=config_path.with_name(".k9-webhook-backup.json"),
            )
        if config_path.exists():
            from .config import save_runtime_preference

            save_runtime_preference(config_path, target)
            print(
                "K9 :: preferred runtime saved in .env. Exported variables take precedence; update them if set."
            )
        else:
            print(
                f"K9 :: set BOT_RUNTIME_MODE={target} in your process environment to retain the preference."
            )
    finally:
        await bridge.close()


class FencedBot(ExtBot):
    """PTB bootstrap normally deletes webhooks; here it is explicitly prevented."""

    __slots__ = ("bridge", "instance_id")

    def __init__(self, config: Config, bridge: Bridge):
        super().__init__(config.bot_token)
        object.__setattr__(self, "bridge", bridge)
        object.__setattr__(self, "instance_id", str(uuid.uuid4()))

    async def delete_webhook(self, *args, **kwargs):
        if (await self.get_webhook_info()).url:
            raise ConfigurationError(
                "Webhook/polling conflict. Use a confirmed --switch-mode python; startup will never delete a webhook."
            )
        return True  # Nothing is deleted: bootstrap only confirms the already-empty webhook.

    async def get_updates(self, *args, **kwargs):
        started = time.monotonic()
        try:
            response = await self.bridge.request("GET", "/runtime")
            state = response["runtime"]
        except BridgeError:
            raise Conflict(
                "Backend receiver fence is unavailable. Stop polling."
            ) from None
        remaining = response.get("leaseRemaining", 0)
        if not isinstance(remaining, int):
            remaining = 0
        deadline = (
            started + remaining
        )  # Subtract the whole request round trip conservatively.
        if (
            response.get("active") is not True
            or state["mode"] != "python"
            or state["instance_id"] != self.instance_id
            or deadline - time.monotonic() <= 35
        ):
            raise Conflict(
                "Receiver lease lost. Polling stopped to preserve the single receiver."
            )
        if (await self.get_webhook_info()).url:
            raise Conflict("A webhook was registered externally; polling is blocked.")
        if deadline - time.monotonic() <= 30:
            raise Conflict(
                "Receiver lease is too close to expiry for another long poll."
            )
        return await super().get_updates(*args, **kwargs)


def build_application(config: Config, bridge: Bridge) -> Application:
    from .menus import StudioBot

    application = (
        Application.builder()
        .bot(FencedBot(config, bridge))
        .concurrent_updates(False)
        .build()
    )
    StudioBot(config, bridge).register(application)
    return application


async def serve(
    config: Config, bridge: Bridge, application: Application, *, on_started=None
):
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    installed = []
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
            installed.append(sig)
        except (NotImplementedError, RuntimeError):
            pass  # Windows Ctrl+C cancels asyncio.run and enters the same finally block.
    initialized = claimed = False
    heartbeat_task = None
    bot = application.bot
    try:
        await application.initialize()
        initialized = True
        await identities(config, bridge, bot)
        if (await bot.get_webhook_info()).url:
            raise ConfigurationError(
                "Webhook exists; --run never removes it. Use --switch-mode python."
            )
        await bridge.request(
            "POST", "/runtime/lease", {"instanceId": bot.instance_id, "action": "claim"}
        )
        claimed = True

        async def heartbeat():
            while not stop.is_set():
                try:
                    await asyncio.wait_for(stop.wait(), timeout=20)
                except TimeoutError:
                    try:
                        await bridge.request(
                            "POST",
                            "/runtime/lease",
                            {"instanceId": bot.instance_id, "action": "heartbeat"},
                        )
                    except BridgeError:
                        stop.set()

        heartbeat_task = asyncio.create_task(heartbeat())

        def poll_error(error):
            if isinstance(error, (Conflict, InvalidToken)):
                print(
                    "K9 :: polling conflict; stopping safely. Inspect webhook, lease and token privately."
                )
                stop.set()
            else:
                print(
                    "K9 :: temporary polling error; PTB will retry safe update reads."
                )

        await application.start()
        await application.updater.start_polling(
            timeout=20,
            bootstrap_retries=0,
            drop_pending_updates=False,
            allowed_updates=["message", "callback_query"],
            error_callback=poll_error,
        )
        if not stop.is_set():
            if on_started is not None:
                on_started()
            else:
                print(
                    "K9 :: Python Telegram receiver running. Ctrl+C stops gracefully. Cloudflare still owns D1/publishing/Cron."
                )
        await stop.wait()
    finally:
        if heartbeat_task:
            heartbeat_task.cancel()
            await asyncio.gather(heartbeat_task, return_exceptions=True)
        if application.updater.running:
            await application.updater.stop()
        if application.running:
            await application.stop()
        if initialized:
            await application.shutdown()
        if claimed:
            try:
                await bridge.request(
                    "POST",
                    "/runtime/lease",
                    {"instanceId": bot.instance_id, "action": "release"},
                )
            except BridgeError:
                pass  # Expiry prevents another process from sharing this lease immediately.
        for sig in installed:
            loop.remove_signal_handler(sig)


async def run(config: Config):
    if config.runtime_mode == "cloudflare":
        await check(config)
        print(
            "K9 :: Cloudflare owns updates 24/7. Python polling was not started. Use management utilities or an approved mode switch."
        )
        return
    bridge = Bridge(config)
    try:
        await serve(config, bridge, build_application(config, bridge))
    finally:
        await bridge.close()
