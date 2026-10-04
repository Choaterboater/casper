"""Safety tests: every tool says whether it changes things and what kind of change it makes, and
--read-only is the only switch that keeps changes off."""

import importlib

import pytest
from mcp import Client

from {{module}}.server import CHANGE_KIND, CHANGE_KINDS, server

server_module = importlib.import_module("{{module}}.server")

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


async def test_every_tool_that_changes_things_names_its_kind() -> None:
    async with Client(server) as client:
        tools = (await client.list_tools()).tools
    missing = [
        tool.name
        for tool in tools
        if not (tool.annotations and tool.annotations.read_only_hint)
        and (tool.meta or {}).get(CHANGE_KIND) not in CHANGE_KINDS
    ]
    assert not missing, f"add meta={{CHANGE_KIND: ...}} to: {', '.join(missing)}"


def test_read_only_is_a_start_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(server.__class__, "run", lambda self, *args, **kwargs: None)
    server_module.main(["--read-only"])
    assert server_module.READ_ONLY is True
    server_module.main([])
    assert server_module.READ_ONLY is False
