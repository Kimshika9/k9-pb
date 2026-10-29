"""Local configuration and an explicit, read-only credential setup wizard."""

from __future__ import annotations
import getpass
import json
import os
import re
import tempfile
import warnings
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit
from dotenv import dotenv_values
from telegram import Bot
from telegram.error import TelegramError
from .diagnostics import telegram_notice


class ConfigurationError(Exception):
    pass


DEFAULT_WEB_APP_URL = "https://k9-pb.kimshikano.workers.dev/"


def secret_input(prompt: str) -> str:
    with warnings.catch_warnings():
        warnings.simplefilter("error", getpass.GetPassWarning)
        try:
            return getpass.getpass(prompt)
        except getpass.GetPassWarning:
            raise ConfigurationError(
                "Hidden secret entry requires a secure terminal; refusing echoed input."
            ) from None


def url_value(value: str, *, origin: bool = False) -> str:
    try:
        if not isinstance(value, str) or value != value.strip():
            raise ValueError()
        url = urlsplit(value)
        local = origin and url.hostname in ("localhost", "127.0.0.1", "::1")
        if (
            not url.hostname
            or url.username
            or url.password
            or url.query
            or url.fragment
            or (url.scheme != "https" and not (local and url.scheme == "http"))
            or (origin and url.path not in ("", "/"))
        ):
            raise ValueError()
        _ = url.port
    except ValueError:
        raise ConfigurationError(
            "Use an HTTPS URL without credentials, query or fragment; API_BASE_URL must be an origin."
        ) from None
    return value.rstrip("/")


@dataclass(frozen=True)
class Config:
    bot_token: str = field(repr=False)
    owner_id: int
    web_app_url: str
    api_base_url: str
    bridge_secret: str = field(repr=False)
    runtime_mode: str = "cloudflare"

    @classmethod
    def from_values(cls, values: dict) -> Config:
        token = values.get("BOT_TOKEN", "")
        owner = str(values.get("OWNER_ID", ""))
        secret = values.get("K9_BRIDGE_SECRET", "")
        if (
            not isinstance(token, str)
            or len(token) > 512
            or not re.fullmatch(r"[1-9]\d*:[A-Za-z0-9_-]{30,}", token)
        ):
            raise ConfigurationError(
                "BOT_TOKEN is missing or malformed. Use the existing token from BotFather."
            )
        if not re.fullmatch(r"[1-9]\d{0,15}", owner) or int(owner) > 2**53 - 1:
            raise ConfigurationError(
                "OWNER_ID must be your positive numeric Telegram user ID."
            )
        if (
            not isinstance(secret, str)
            or not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", secret)
            or secret.startswith("replace_")
        ):
            raise ConfigurationError(
                "K9_BRIDGE_SECRET must match the separate configured Worker bridge secret."
            )
        mode = values.get("BOT_RUNTIME_MODE", "cloudflare")
        if mode not in ("cloudflare", "python"):
            raise ConfigurationError("BOT_RUNTIME_MODE must be cloudflare or python.")
        web = url_value(values.get("WEB_APP_URL", DEFAULT_WEB_APP_URL))
        api = url_value(values.get("API_BASE_URL", web), origin=True)
        return cls(token, int(owner), web, api, secret, mode)

    @classmethod
    def load(cls, path: Path = Path(".env")) -> Config:
        # Do not seed os.environ with old .env preferences during a mode change.
        return cls.from_values({**dotenv_values(path), **os.environ})

    def environment(self) -> dict[str, str]:
        return {
            "BOT_TOKEN": self.bot_token,
            "OWNER_ID": str(self.owner_id),
            "WEB_APP_URL": self.web_app_url,
            "API_BASE_URL": self.api_base_url,
            "K9_BRIDGE_SECRET": self.bridge_secret,
            "BOT_RUNTIME_MODE": self.runtime_mode,
        }


def private_write(path: Path, text: str) -> None:
    """Atomic write with 0600; never follow an existing symlink."""
    if path.is_symlink():
        raise ConfigurationError("Refusing to replace a symlinked credential file.")
    descriptor, temporary = tempfile.mkstemp(prefix=".k9-private-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as file:
            file.write(text)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
        if os.name != "nt":
            os.chmod(path, 0o600)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


async def setup(
    path: Path = Path(".env"),
    *,
    prompt=input,
    hidden=secret_input,
    bot_factory=Bot,
    choose_runtime: bool = True,
) -> Config:
    print(
        "K9 :: private setup. This checks getMe only; it does not change the webhook."
    )
    values = {
        "BOT_TOKEN": hidden("Telegram Bot Token (hidden): "),
        "OWNER_ID": prompt("Owner numeric Telegram ID: ").strip(),
        "WEB_APP_URL": prompt(f"K9 Web App HTTPS URL [{DEFAULT_WEB_APP_URL}]: ").strip()
        or DEFAULT_WEB_APP_URL,
        "K9_BRIDGE_SECRET": hidden("Worker K9_BRIDGE_SECRET (hidden): "),
        "BOT_RUNTIME_MODE": (
            (
                prompt("Preferred runtime [cloudflare/python] (cloudflare): ").strip()
                or "cloudflare"
            )
            if choose_runtime
            else "python"
        ),
    }
    values["API_BASE_URL"] = values["WEB_APP_URL"].rstrip("/")
    config = Config.from_values(values)
    try:
        async with bot_factory(config.bot_token) as telegram:
            me = await telegram.get_me()
            if not me.is_bot:
                raise ConfigurationError("Telegram did not confirm a bot account.")
    except TelegramError as error:
        raise ConfigurationError(
            f"Setup could not verify the bot: {telegram_notice(error)} Existing settings were not replaced."
        ) from None
    if (
        path.exists()
        and prompt("Replace these bot settings in the existing .env? Type SAVE: ")
        != "SAVE"
    ):
        raise ConfigurationError("Setup cancelled; existing credentials preserved.")
    saved = dict(dotenv_values(path)) if path.exists() else {}
    saved.update(config.environment())
    private_write(
        path,
        "# Local credentials. Never commit or share.\n"
        + "\n".join(
            f"{key}={json.dumps(value, ensure_ascii=False)}"
            for key, value in saved.items()
            if value is not None
        )
        + "\n",
    )
    print(
        "K9 :: configuration saved privately. Checking backend before starting..."
        if not choose_runtime
        else "K9 :: configuration saved privately. Receiver settings were not changed."
    )
    return config


def save_runtime_preference(path: Path, mode: str) -> None:
    """Change only the saved preference; exported settings remain untouched."""
    if not path.exists():
        return  # Environment-only operators need not create a credentials file.
    values = dict(dotenv_values(path))
    values["BOT_RUNTIME_MODE"] = mode
    private_write(
        path,
        "# Local credentials. Never commit or share.\n"
        + "\n".join(
            f"{key}={json.dumps(value, ensure_ascii=False)}"
            for key, value in values.items()
            if value is not None
        )
        + "\n",
    )
