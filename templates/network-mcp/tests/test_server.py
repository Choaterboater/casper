"""The server, tested in memory: a real MCP client talks to it without starting a process."""

import importlib
import json

import httpx
import pytest
import respx
from mcp import Client

from {{module}}.server import server

server_module = importlib.import_module("{{module}}.server")

pytestmark = pytest.mark.anyio

# Sample data, not from your org.
ORG = "00000000-0000-0000-0000-000000000001"
SITE = "00000000-0000-0000-0000-000000000012"
SELF_READER = {
    "email": "noc@example.com",
    "privileges": [{"scope": "org", "role": "read", "org_id": ORG, "name": "Example Org"}],
}


async def access() -> dict:
    async with Client(server) as client:
        result = await client.call_tool("access_check", {})
    return result.structured_content or json.loads(result.content[0].text)


async def test_lists_access_check() -> None:
    async with Client(server) as client:
        tools = await client.list_tools()
    assert "access_check" in [tool.name for tool in tools.tools]


@respx.mock
async def test_access_check_reports_what_mist_says() -> None:
    route = respx.get("https://api.mist.com/api/v1/self").mock(
        return_value=httpx.Response(200, json=SELF_READER)
    )
    body = await access()
    assert route.called
    assert route.calls.last.request.headers["authorization"] == "Token sample-token"
    product = body["products"][0]
    assert body["contract"] == "casper/access-check v2"
    assert product["product"] == "mist"
    assert product["access"] == "read-only"
    assert product["read_only"] == [{"kind": "org", "id": ORG, "name": "Example Org"}]
    assert product["server_gate"] == {"flag": "--read-only", "state": "on"}


@respx.mock
async def test_read_only_flag_shows_in_the_gate(monkeypatch: pytest.MonkeyPatch) -> None:
    respx.get("https://api.mist.com/api/v1/self").mock(
        return_value=httpx.Response(200, json=SELF_READER)
    )
    monkeypatch.setattr(server_module, "READ_ONLY", True)
    body = await access()
    assert body["products"][0]["server_gate"] == {"flag": "--read-only", "state": "off"}


@respx.mock
async def test_a_write_login_says_where_it_can_change_things() -> None:
    admin = {
        "email": "admin@example.com",
        "privileges": [
            {"scope": "site", "role": "write", "site_id": SITE, "name": "Branch-12"},
            {"scope": "org", "role": "read", "org_id": ORG, "name": "Example Org"},
        ],
    }
    respx.get("https://api.mist.com/api/v1/self").mock(return_value=httpx.Response(200, json=admin))
    product = (await access())["products"][0]
    assert product["access"] == "read-write"
    assert product["can_change"] == [{"kind": "site", "id": SITE, "name": "Branch-12"}]


async def test_no_token_is_a_missing_login(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("MIST_API_TOKEN")
    product = (await access())["products"][0]
    assert product["login"] == "missing"
    assert product["access"] == "unknown"
