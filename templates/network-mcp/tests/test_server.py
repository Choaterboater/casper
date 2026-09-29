"""The server, tested in memory: a real MCP client talks to it without starting a process."""

import json

import httpx
import pytest
import respx
from mcp import Client

from {{module}}.server import server

pytestmark = pytest.mark.anyio

# Sample data, not from your org.
SELF_READ_ONLY = {
    "email": "noc@example.com",
    "privileges": [
        {"scope": "org", "role": "read", "org_id": "00000000-0000-0000-0000-000000000001"},
    ],
}


async def test_lists_access_check() -> None:
    async with Client(server) as client:
        tools = await client.list_tools()
    assert "access_check" in [tool.name for tool in tools.tools]


@respx.mock
async def test_access_check_reports_what_mist_says() -> None:
    route = respx.get("https://api.mist.com/api/v1/self").mock(
        return_value=httpx.Response(200, json=SELF_READ_ONLY)
    )
    async with Client(server) as client:
        result = await client.call_tool("access_check", {})
    assert route.called
    assert route.calls.last.request.headers["authorization"] == "Token sample-token"
    body = result.structured_content or json.loads(result.content[0].text)
    product = body["products"][0]
    assert body["contract"] == "casper/access-check v1"
    assert product["product"] == "mist"
    assert product["access"] == "read-only"
    assert product["server_gate"] == {"env_var": "{{env}}_READ_ONLY", "state": "disabled"}


@respx.mock
async def test_admin_token_is_read_write() -> None:
    admin = {"email": "admin@example.com", "privileges": [{"scope": "org", "role": "admin"}]}
    respx.get("https://api.mist.com/api/v1/self").mock(return_value=httpx.Response(200, json=admin))
    async with Client(server) as client:
        result = await client.call_tool("access_check", {})
    body = result.structured_content or json.loads(result.content[0].text)
    assert body["products"][0]["access"] == "read-write"
