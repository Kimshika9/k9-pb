"""Credential-free diagnostics for the exact config and signed bridge GET used by startup."""

from __future__ import annotations

import os
from pathlib import Path

import httpx
from dotenv import dotenv_values

from .bridge import Bridge, BridgeError
from .config import Config, ConfigurationError
from .startup import backend_notice


async def diagnose_bridge(
    config_path: Path, *, client: httpx.AsyncClient | None = None
) -> None:
    """Never mutate settings/receivers or send Telegram messages. Signed GET reserves a nonce."""
    print("K9 :: bridge diagnostics; no publishing or receiver changes.")
    print(f"K9 :: config file: {config_path.resolve()}")
    print("K9 :: config file " + ("exists." if config_path.is_file() else "is absent."))
    saved = dotenv_values(config_path)
    exported = "K9_BRIDGE_SECRET" in os.environ
    print(
        "K9 :: bridge secret source: "
        + ("exported environment (overrides .env)." if exported else "saved .env.")
    )
    if exported and saved.get("K9_BRIDGE_SECRET") is not None:
        if os.environ["K9_BRIDGE_SECRET"] != saved["K9_BRIDGE_SECRET"]:
            print(
                "K9 :: MISMATCH: exported K9_BRIDGE_SECRET differs from .env. "
                "Updating .env alone cannot change the secret this process uses. "
                "Correct/remove the exported override in your terminal or IDE, then restart Python."
            )
    for name in ("BOT_TOKEN", "OWNER_ID", "API_BASE_URL", "WEB_APP_URL"):
        if (
            name in os.environ
            and saved.get(name) is not None
            and os.environ[name] != saved[name]
        ):
            print(f"K9 :: exported {name} also overrides a different saved value.")
    config = Config.load(config_path)
    # Config validation excludes URL credentials, query strings and fragments.
    print(f"K9 :: backend origin: {config.api_base_url}")
    bridge = Bridge(config, client)
    try:
        try:
            identity = await bridge.request("GET", "/identity")
        except BridgeError as error:
            raise backend_notice(error) from None
        if bridge.clock_skew_seconds is not None:
            print(
                "K9 :: TLS response clock estimate (server minus device): "
                f"{bridge.clock_skew_seconds:+.0f}s. Not used to alter authentication."
            )
        if (
            type(identity.get("ownerId")) is not int
            or identity["ownerId"] != config.owner_id
            or type(identity.get("botId")) is not int
            or identity["botId"] != int(config.bot_token.split(":", 1)[0])
            or not isinstance(identity.get("webAppUrl"), str)
            or identity["webAppUrl"].rstrip("/") != config.web_app_url
        ):
            raise ConfigurationError(
                "Bridge authentication succeeded, but local bot/owner/Web App identity differs. "
                "Correct the matching private settings before normal startup."
            )
        print(
            "K9 :: bridge HMAC accepted; configured bot/owner/Web App identity matches."
        )
        print(
            "K9 :: normal startup: python bot.py. No webhook or credentials were changed."
        )
    finally:
        await bridge.close()
