"""Public route checks must distinguish old authentication from an available bridge."""

import io
import json
import urllib.error
from unittest.mock import patch, MagicMock

import pytest

from check_k9_backend import check


@pytest.mark.parametrize(
    "status,code,result,notice",
    [
        (401, "INVALID_BRIDGE_AUTH", 0, "route is present"),
        (401, "INVALID_AUTH", 1, "Mini App authentication"),
        (503, "NOT_CONFIGURED", 1, "configuration/storage"),
        (403, "FORBIDDEN", 1, "availability is unconfirmed"),
        (200, None, 1, "availability is unconfirmed"),
    ],
)
def test_unsigned_probe_classifies_actual_response(
    status, code, result, notice, capsys
):
    response = urllib.error.HTTPError(
        "https://studio.example.com/api/bridge/identity",
        status,
        "synthetic",
        {"Content-Type": "application/json"},
        io.BytesIO(json.dumps({"error": {"code": code}}).encode()),
    )
    opener = MagicMock()
    if status >= 400:
        opener.open.side_effect = response
    else:
        opener.open.return_value = response
    with patch("check_k9_backend.urllib.request.build_opener", return_value=opener):
        assert check("https://studio.example.com") == result
    request = opener.open.call_args.args[0]
    assert request.get_method() == "GET" and request.data is None
    assert all(
        not name.lower().startswith(("authorization", "x-k9"))
        for name in request.headers
    )
    assert notice in capsys.readouterr().out


def test_untrusted_response_is_not_echoed_or_reported_healthy(capsys):
    response = urllib.error.HTTPError(
        "https://studio.example.com/api/bridge/identity",
        403,
        "synthetic",
        {"Content-Type": "text/html"},
        io.BytesIO(b"PRIVATE_UPSTREAM_RESPONSE"),
    )
    opener = MagicMock()
    opener.open.side_effect = response
    with patch("check_k9_backend.urllib.request.build_opener", return_value=opener):
        assert check("https://studio.example.com") == 1
    assert "PRIVATE_UPSTREAM_RESPONSE" not in capsys.readouterr().out


def test_origin_credentials_are_rejected_without_network_or_echo(capsys):
    with patch("check_k9_backend.urllib.request.build_opener") as network:
        assert check("https://user:PRIVATE_PASSWORD@studio.example.com") == 1
        network.assert_not_called()
    assert "PRIVATE_PASSWORD" not in capsys.readouterr().out


def test_connection_failure_never_claims_a_deployment_rollback(capsys):
    opener = MagicMock()
    opener.open.side_effect = urllib.error.URLError("PRIVATE_TRANSPORT_DETAILS")
    with patch("check_k9_backend.urllib.request.build_opener", return_value=opener):
        assert check("https://studio.example.com") == 1
    output = capsys.readouterr().out
    assert "response unconfirmed" in output
    assert (
        "PRIVATE_TRANSPORT_DETAILS" not in output
        and "Mini App authentication" not in output
    )
