#!/usr/bin/env python3
"""K9 Studio: real Telegram bot in Python mode, safe utilities in Cloudflare mode."""

from __future__ import annotations
import argparse
import asyncio
import logging
import sys
from pathlib import Path

# Preserve Phase 3 CLI and signature imports without requiring PTB in Worker test environments.
from k9bot.cli import Client, ControllerError, NoRedirect, signed_headers
from k9bot.cli import main as controller_main


def create_application(config, bridge):
    """Initialize the python-telegram-bot Application and actual Telegram handlers."""
    from k9bot.runtime import build_application

    return build_application(config, bridge)


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if args and args[0] in (
        "doctor",
        "status",
        "channels",
        "posts",
        "scheduled",
        "preview",
        "publish",
    ):
        return controller_main(args)
    parser = argparse.ArgumentParser(
        description="K9 Studio :: advanced owner-only Telegram bot"
    )
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument(
        "--setup",
        action="store_true",
        help="Hidden-token setup wizard; checks getMe, never switches webhook",
    )
    actions.add_argument(
        "--check",
        action="store_true",
        help="Read-only token, backend and webhook diagnostics",
    )
    actions.add_argument(
        "--diagnose-bridge",
        action="store_true",
        help="Show config sources, clock estimate and signed bridge identity; never changes webhook",
    )
    actions.add_argument(
        "--run",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    actions.add_argument(
        "--switch-mode",
        choices=("python", "cloudflare"),
        help="Explicitly confirmed receiver switch; preserves/restores the webhook",
    )
    actions.add_argument(
        "--restore-cloudflare",
        action="store_true",
        help="Restore the existing Cloudflare webhook after stopping Python; requires confirmation",
    )
    options = parser.parse_args(args)
    try:
        from k9bot.config import Config, ConfigurationError, setup
        from k9bot.runtime import check, switch_mode
        from k9bot.startup import start, backend_notice

        config_path = Path(__file__).resolve().with_name(".env")

        logging.basicConfig(
            level=logging.WARNING, format="K9 :: %(levelname)s :: %(message)s"
        )
        # Never print HTTP request URLs, exception reprs, Telegram updates or headers.
        for handler in logging.getLogger().handlers:
            handler.addFilter(lambda record: record.name.startswith("k9"))
        for name in ("httpx", "httpcore", "telegram"):
            logging.getLogger(name).setLevel(logging.CRITICAL)
        if options.setup:
            asyncio.run(setup(config_path, choose_runtime=False))
        elif options.diagnose_bridge:
            from k9bot.bridge_diagnostics import diagnose_bridge

            asyncio.run(diagnose_bridge(config_path))
        elif options.check or options.switch_mode or options.restore_cloudflare:
            config = Config.load(config_path)
            target = "cloudflare" if options.restore_cloudflare else options.switch_mode
            asyncio.run(
                switch_mode(config, target, config_path=config_path)
                if target
                else check(config)
            )
        else:
            asyncio.run(start(config_path))
        return 0
    except ImportError:
        print(
            "K9 :: install Python dependencies: python -m pip install -r requirements.txt",
            file=sys.stderr,
        )
        return 1
    except KeyboardInterrupt:
        print("K9 :: stopped.", file=sys.stderr)
        return 0
    except Exception as error:
        # Only our deliberately sanitized errors may reach the terminal.
        from k9bot.bridge import BridgeError
        from k9bot.config import ConfigurationError
        from k9bot.diagnostics import telegram_notice
        from telegram.error import TelegramError

        if isinstance(error, BridgeError):
            message = str(backend_notice(error))
        elif isinstance(error, ConfigurationError):
            message = str(error)
        elif isinstance(error, TelegramError):
            message = telegram_notice(error)
        else:
            message = "Telegram or backend operation failed. Check configuration privately; no uncertain write was retried."
        print("K9 :: " + message, file=sys.stderr)
        return 1


if __name__ == "__main__":
    if sys.version_info < (3, 12):
        print("Python 3.12+ is required.", file=sys.stderr)
        raise SystemExit(1)
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    raise SystemExit(main())
