"""Python controller tests use synthetic credentials and mocked HTTP only."""

import contextlib
import hashlib
import hmac
import io
import json
import os
import unittest
from unittest.mock import patch, MagicMock
import bot

SECRET = "test_only_scoped_cli_secret_32_plus_characters"


class ControllerTests(unittest.TestCase):
    def test_exact_utf8_signature_and_request_expiry_fields(self):
        body = '{"text":"မြန်မာ"}'.encode("utf-8")
        headers = bot.signed_headers(
            SECRET, "POST", "/api/cli/posts/123/preview", body, 1000, "a" * 32
        )
        check = "\n".join(
            (
                "1000",
                "a" * 32,
                "POST",
                "/api/cli/posts/123/preview",
                hashlib.sha256(body).hexdigest(),
            )
        )
        self.assertEqual(
            headers["X-K9-Signature"],
            hmac.new(SECRET.encode(), check.encode(), hashlib.sha256).hexdigest(),
        )
        self.assertNotIn(SECRET, json.dumps(headers))

    def test_environment_validation_and_loopback_support(self):
        for url in [
            "http://example.com",
            "https://user:pass@example.com",
            "https://example.com/?token=bad",
            "https://example.com/api",
        ]:
            with patch.dict(os.environ, {"K9_API_URL": url, "K9_CLI_SECRET": SECRET}):
                with self.assertRaises(bot.ControllerError):
                    bot.Client.from_environment()
        with patch.dict(
            os.environ, {"K9_API_URL": "http://127.0.0.1:5173", "K9_CLI_SECRET": SECRET}
        ):
            self.assertEqual(
                bot.Client.from_environment().base_url, "http://127.0.0.1:5173"
            )

    def test_read_commands_and_successful_publication_use_worker_only(self):
        for command in ["doctor", "status", "channels", "posts", "scheduled"]:
            with patch.object(
                bot.Client,
                "from_environment",
                return_value=bot.Client("https://studio.example.com", SECRET),
            ), patch.object(
                bot.Client, "request", return_value={"ok": True}
            ) as request, contextlib.redirect_stdout(
                io.StringIO()
            ):
                self.assertEqual(bot.main([command]), 0)
                request.assert_called_once_with("GET", "/api/cli/" + command)
        operation = "12345678-1234-4234-8234-123456789012"
        with patch.object(
            bot.Client,
            "from_environment",
            return_value=bot.Client("https://studio.example.com", SECRET),
        ), patch.object(
            bot.Client,
            "request",
            side_effect=[
                {"post": {"revision": 4}},
                {"publication": {"status": "published", "telegram_message_id": 1}},
            ],
        ) as request, contextlib.redirect_stdout(
            io.StringIO()
        ):
            self.assertEqual(
                bot.main(
                    ["publish", "post-id", "channel-id", "--operation-id", operation]
                ),
                0,
            )
            self.assertEqual(
                request.call_args.args,
                (
                    "POST",
                    "/api/cli/posts/post-id/publish",
                    {
                        "operationId": operation,
                        "revision": 4,
                        "channelId": "channel-id",
                    },
                ),
            )

    def test_transport_signs_exact_body_and_never_follows_redirects(self):
        response = MagicMock()
        response.__enter__.return_value = response
        response.headers = {"Content-Type": "application/json"}
        response.read.return_value = b'{"ok":true}'
        opener = MagicMock()
        opener.open.return_value = response
        with patch("urllib.request.build_opener", return_value=opener) as factory:
            result = bot.Client("https://studio.example.com", SECRET).request(
                "POST", "/api/cli/posts/p/preview", {"revision": 1}
            )
            self.assertTrue(result["ok"])
            request = opener.open.call_args.args[0]
            self.assertEqual(request.data, b'{"revision":1}')
            self.assertIsInstance(factory.call_args.args[0], bot.NoRedirect)
            self.assertNotIn(SECRET, str(request.header_items()))

    def test_uncertain_error_preserves_operation_id_without_exposing_credentials(self):
        output = io.StringIO()
        operation = "12345678-1234-4234-8234-123456789012"
        with patch.object(
            bot.Client,
            "from_environment",
            return_value=bot.Client("https://studio.example.com", SECRET),
        ), patch.object(
            bot.Client, "request", side_effect=bot.ControllerError("Delivery uncertain")
        ), contextlib.redirect_stderr(
            output
        ):
            self.assertEqual(
                bot.main(
                    [
                        "preview",
                        "post-id",
                        "--revision",
                        "1",
                        "--operation-id",
                        operation,
                    ]
                ),
                1,
            )
        self.assertIn(operation, output.getvalue())
        self.assertNotIn(SECRET, output.getvalue())


if __name__ == "__main__":
    unittest.main()
