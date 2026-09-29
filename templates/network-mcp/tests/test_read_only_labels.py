"""Safety tests: every tool says whether it changes things, and writes stay off by default."""

import pytest
from mcp import Client

from {{module}}.server import server, writes_enabled

pytestmark = pytest.mark.anyio


async def test_every_tool_says_if_it_changes_things() -> None:
    async with Client(server) as client:
        tools = (await client.list_tools()).tools
    assert tools, "the server has no tools"
    unlabeled = [
        tool.name
        for tool in tools
        if tool.annotations is None
        or (tool.annotations.read_only_hint is None and tool.annotations.destructive_hint is None)
    ]
    assert not unlabeled, f"add readOnlyHint or destructiveHint to: {', '.join(unlabeled)}"


async def test_read_only_tools_are_not_destructive() -> None:
    async with Client(server) as client:
        tools = (await client.list_tools()).tools
    for tool in tools:
        if tool.annotations and tool.annotations.read_only_hint:
            assert not tool.annotations.destructive_hint, tool.name


def test_writes_are_off_by_default() -> None:
    assert writes_enabled() is False


@pytest.mark.parametrize("value", ["false", "0", "no", "off", " FALSE "])
def test_writes_turn_on_only_when_read_only_is_off(
    monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    monkeypatch.setenv("{{env}}_READ_ONLY", value)
    assert writes_enabled() is True


@pytest.mark.parametrize("value", ["true", "1", "yes", "", "anything"])
def test_other_values_keep_writes_off(monkeypatch: pytest.MonkeyPatch, value: str) -> None:
    monkeypatch.setenv("{{env}}_READ_ONLY", value)
    assert writes_enabled() is False
