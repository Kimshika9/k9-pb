#!/usr/bin/env python3
"""Public bridge-route check. Standard library only; no credentials or Telegram writes."""

from __future__ import annotations

import argparse
import json
import re
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_ORIGIN = "https://k9-pb.kimshikano.workers.dev"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def check(origin: str) -> int:
    try:
        url = urllib.parse.urlsplit(origin)
        if (
            url.scheme != "https"
            or not url.hostname
            or url.username
            or url.password
            or url.query
            or url.fragment
            or url.path not in ("", "/")
            or origin != origin.strip()
        ):
            raise ValueError()
        _ = url.port
    except ValueError:
        print("K9 :: use an HTTPS origin without credentials, path, query or fragment.")
        return 1
    target = origin.rstrip("/") + "/api/bridge/identity"
    print("K9 :: public bridge check: " + target)
    print("K9 :: no token/secret is read or sent; no receiver or publication changes.")
    try:
        opener = urllib.request.build_opener(NoRedirect())
        try:
            response = opener.open(
                urllib.request.Request(target, headers={"Accept": "application/json"}),
                timeout=20,
            )
        except urllib.error.HTTPError as error:
            response = error  # 401 is the expected healthy public response.
        with response:
            status = response.code
            raw = response.read(65_537)
            data = (
                json.loads(raw)
                if len(raw) <= 65_536
                and "application/json" in response.headers.get("Content-Type", "")
                else {}
            )
    except (urllib.error.URLError, OSError, ValueError):
        print(
            "K9 :: response unconfirmed. Check network/TLS; do not disable certificate verification."
        )
        return 1
    detail = data.get("error", {}) if isinstance(data, dict) else {}
    code = detail.get("code") if isinstance(detail, dict) else None
    if not isinstance(code, str) or not re.fullmatch(r"[A-Z0-9_]{1,80}", code):
        code = "UNCONFIRMED_RESPONSE"
    print(f"K9 :: HTTP {status}; code {code}")
    if status == 401 and code == "INVALID_BRIDGE_AUTH":
        print(
            "K9 :: bridge authentication route is present. This does not test your private secret."
        )
        print("K9 :: next: python bot.py --diagnose-bridge")
        return 0
    if status == 401 and code == "INVALID_AUTH":
        print("K9 :: this origin routes bridge requests into Mini App authentication.")
        print(
            "K9 :: deploy the reviewed bridge Worker or correct API_BASE_URL; changing the secret cannot fix this routing."
        )
    elif status == 503:
        print(
            "K9 :: Worker configuration/storage is not ready; inspect the reported code privately."
        )
    else:
        print(
            "K9 :: bridge availability is unconfirmed; inspect deployment/routing before changing credentials."
        )
    return 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("origin", nargs="?", default=DEFAULT_ORIGIN)
    return check(parser.parse_args().origin)


if __name__ == "__main__":
    raise SystemExit(main())
