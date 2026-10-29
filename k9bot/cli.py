#!/usr/bin/env python3
"""K9 controller. No Telegram polling, webhook receiver, or local publishing logic."""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass, field
from typing import Any


class ControllerError(Exception):
    """Sanitized operator error; never retains headers or credential values."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def signed_headers(
    secret: str,
    method: str,
    path: str,
    body: bytes,
    timestamp: int | None = None,
    nonce: str | None = None,
) -> dict[str, str]:
    stamp = str(int(time.time()) if timestamp is None else timestamp)
    request_nonce = uuid.uuid4().hex if nonce is None else nonce
    canonical = "\n".join(
        (stamp, request_nonce, method.upper(), path, hashlib.sha256(body).hexdigest())
    )
    signature = hmac.new(
        secret.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    return {
        "X-K9-Timestamp": stamp,
        "X-K9-Nonce": request_nonce,
        "X-K9-Signature": signature,
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


@dataclass
class Client:
    base_url: str
    secret: str = field(repr=False)
    timeout: float = 60

    @classmethod
    def from_environment(cls) -> Client:
        base = os.environ.get("K9_API_URL", "").rstrip("/")
        secret = os.environ.get("K9_CLI_SECRET", "")
        try:
            url = urllib.parse.urlsplit(base)
            local = url.hostname in ("localhost", "127.0.0.1", "::1")
            if (
                not url.hostname
                or url.username
                or url.password
                or url.query
                or url.fragment
                or url.path
                or not (url.scheme == "https" or (url.scheme == "http" and local))
            ):
                raise ValueError()
        except ValueError:
            raise ControllerError(
                "Set K9_API_URL to your studio HTTPS origin (HTTP is allowed only for local loopback tests)."
            ) from None
        if not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", secret) or secret.startswith(
            "replace_"
        ):
            raise ControllerError(
                "Set K9_CLI_SECRET securely to the existing Worker CLI_AUTH_SECRET. Do not paste secrets into chat or source."
            )
        return cls(base, secret)

    def request(
        self, method: str, path: str, payload: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        if not path.startswith("/api/cli/") or "\n" in path:
            raise ControllerError("Controller requests must use the private CLI API.")
        body = (
            b""
            if payload is None
            else json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode(
                "utf-8"
            )
        )
        headers = signed_headers(self.secret, method, path, body)
        request = urllib.request.Request(
            self.base_url + path,
            data=None if method == "GET" else body,
            headers=headers,
            method=method,
        )
        opener = urllib.request.build_opener(NoRedirect())
        try:
            with opener.open(request, timeout=self.timeout) as response:
                raw = response.read(2_000_001)
                if len(
                    raw
                ) > 2_000_000 or "application/json" not in response.headers.get(
                    "Content-Type", ""
                ):
                    raise ControllerError(
                        "The backend returned an invalid API response."
                    )
                result = json.loads(raw)
                if not isinstance(result, dict):
                    raise ControllerError(
                        "The backend returned an invalid API response."
                    )
                return result
        except urllib.error.HTTPError as error:
            try:
                value = json.loads(error.read(65_536))
                detail = value.get("error", {}) if isinstance(value, dict) else {}
                code = detail.get("code", "REQUEST_FAILED")
                message = detail.get(
                    "message", "Request rejected; check access and configuration."
                )
                if not isinstance(code, str) or not isinstance(message, str):
                    raise ValueError()
                safe = f"{code[:80]}: {message[:1500]}".replace(
                    self.secret, "[redacted]"
                )
            except (ValueError, AttributeError, TypeError):
                safe = f"HTTP {error.code}: Request rejected; check access and configuration."
            raise ControllerError(safe) from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise ControllerError(
                "No API confirmation received. A write may have completed; check the operation status before resending."
            ) from None
        except (ValueError, UnicodeDecodeError):
            raise ControllerError(
                "The backend returned malformed JSON. A write outcome may be uncertain."
            ) from None


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="K9 Post Studio :: secure Cloudflare controller (no polling)"
    )
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("doctor", "channels", "posts", "scheduled"):
        commands.add_parser(name)
    status = commands.add_parser("status")
    status.add_argument(
        "--operation-id", help="Inspect a pending/uncertain operation without resending"
    )
    for name in ("preview", "publish"):
        command = commands.add_parser(name)
        command.add_argument("post_id")
        if name == "publish":
            command.add_argument(
                "channel_id",
                help="Approved channel UUID from the studio, not an arbitrary Telegram chat",
            )
        command.add_argument(
            "--operation-id", help="Reuse this UUID for an idempotent retry"
        )
        command.add_argument(
            "--revision",
            type=int,
            help="Expected saved draft revision (otherwise fetched securely)",
        )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    operation_id: str | None = None
    try:
        client = Client.from_environment()
        if args.command in ("preview", "publish"):
            operation_id = (
                str(uuid.UUID(args.operation_id))
                if args.operation_id
                else str(uuid.uuid4())
            )
            post_id = urllib.parse.quote(args.post_id, safe="")
            revision = args.revision
            if revision is None:
                post = client.request("GET", f"/api/cli/posts/{post_id}")
                revision = post["post"]["revision"]
            if not isinstance(revision, int) or revision <= 0:
                raise ControllerError("A positive saved draft revision is required.")
            payload = {"operationId": operation_id, "revision": revision}
            if args.command == "publish":
                payload["channelId"] = args.channel_id
            result = client.request(
                "POST", f"/api/cli/posts/{post_id}/{args.command}", payload
            )
        elif args.command == "status" and args.operation_id:
            operation = str(uuid.UUID(args.operation_id))
            result = client.request("GET", f"/api/cli/operations/{operation}")
        else:
            result = client.request("GET", f"/api/cli/{args.command}")
        print(
            json.dumps(result, ensure_ascii=False, indent=2).replace(
                client.secret, "[redacted]"
            )
        )
        return 0
    except (ControllerError, ValueError, KeyError, TypeError) as error:
        message = (
            str(error)
            if isinstance(error, ControllerError)
            else "Invalid operation ID or backend response; check the command arguments."
        )
        print(f"K9 :: {message}", file=sys.stderr)
        if operation_id:
            print(
                f"Operation ID: {operation_id}. Inspect with: python bot.py status --operation-id {operation_id}. Do not create a new request for an uncertain send.",
                file=sys.stderr,
            )
        return 1


if __name__ == "__main__":
    if sys.version_info < (3, 12):
        print("Python 3.12+ is required.", file=sys.stderr)
        raise SystemExit(1)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    raise SystemExit(main())
