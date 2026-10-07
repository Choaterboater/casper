"""The {{name}} MCP server.

Every tool says whether it changes things (readOnlyHint / destructiveHint), and every tool that
changes things also says what kind of change it makes (`_meta["casper/change-kind"]`). Start it
with --read-only to keep every change off; nothing turns writes on while it runs. There are no
write tools yet.

Settings (environment):
  MIST_API_TOKEN      a Mist API token; use a read-only one
  MIST_HOST           the Mist API host (default api.mist.com)
"""

from __future__ import annotations

import argparse
import os
import re
from typing import Any

import httpx
from mcp.server.mcpserver import MCPServer
from mcp.types import ToolAnnotations

ACCESS_CONTRACT = "casper/access-check v2"

# What kind of change a tool makes, for Casper's change box: config, troubleshoot, disruptive
# (reboot, bounce), firmware, delete or admin. Register a write tool like this:
#   @server.tool(annotations=WRITES, meta={CHANGE_KIND: "config"})
# and check READ_ONLY in it first: a change must never run while the server is read-only.
CHANGE_KIND = "casper/change-kind"
CHANGE_KINDS = frozenset({"troubleshoot", "config", "disruptive", "firmware", "delete", "admin"})

# Labels the client sees; tests check every tool has one.
READS = ToolAnnotations(read_only_hint=True, destructive_hint=False, open_world_hint=True)
WRITES = ToolAnnotations(read_only_hint=False, destructive_hint=False, open_world_hint=True)

# Set once at start from --read-only (main). Nothing changes it while the server runs.
READ_ONLY = False

server = MCPServer("{{name}}")


def mist_host() -> str:
    return os.environ.get("MIST_HOST", "api.mist.com").strip() or "api.mist.com"


def mist_token() -> str:
    return os.environ.get("MIST_API_TOKEN", "").strip()


def mist_client() -> httpx.AsyncClient:
    token = mist_token()
    if not token:
        raise RuntimeError("MIST_API_TOKEN isn't set. Use a read-only Mist token.")
    return httpx.AsyncClient(
        base_url=f"https://{mist_host()}",
        headers={"Authorization": f"Token {token}", "Accept": "application/json"},
        timeout=30,
    )


#: What Casper accepts in a scope list: at most 64 entries, each id and name short and plain.
MAX_SCOPES = 64
PLAIN = re.compile(r"^[A-Za-z0-9 _.@:/+-]{1,64}$")


def mist_report(me: dict[str, Any]) -> dict[str, Any]:
    """The Mist part of the answer: read-write when any role is admin or write, read-only when
    every role reads, else unknown. Lists the orgs and sites it can change, and where it can
    only read."""
    privileges = [p for p in me.get("privileges") or [] if isinstance(p, dict)]
    roles = {str(p.get("role", "")).lower() for p in privileges}
    if not roles:
        access = "unknown"
    elif roles & {"admin", "write"}:
        access = "read-write"
    elif roles <= {"read", "helpdesk", "installer"}:
        access = "read-only"
    else:
        access = "unknown"
    entry: dict[str, Any] = {
        "product": "mist",
        "access": access,
        "identity": me.get("email") or me.get("name") or "api token",
        "role": "/".join(sorted(roles)) or "none",
    }
    if access == "unknown":
        return entry
    can_change: list[dict[str, str]] = []
    read_only: list[dict[str, str]] = []
    # All or nothing: a privilege this server can't list (a site group, an MSP, a name that
    # isn't plain) would make a shorter list understate where the login can change things,
    # so then neither list is sent.
    complete = True
    for privilege in privileges:
        scope = privilege.get("scope")
        scope_id = privilege.get(f"{scope}_id") if scope in ("org", "site") else None
        name = str(privilege.get("name") or scope_id)
        plain = isinstance(scope_id, str) and PLAIN.match(scope_id) and PLAIN.match(name)
        if not plain:
            complete = False
            continue
        item = {"kind": str(scope), "id": scope_id, "name": name}
        writes = str(privilege.get("role", "")).lower() in {"admin", "write"}
        (can_change if writes else read_only).append(item)
    if not complete or len(can_change) > MAX_SCOPES or len(read_only) > MAX_SCOPES:
        return entry
    if can_change:
        entry["can_change"] = can_change
    if read_only:
        entry["read_only"] = read_only
    return entry


@server.tool(annotations=READS)
async def access_check() -> dict[str, Any]:
    """What the Mist login may do, as Mist itself reports it (GET /api/v1/self). Read-only."""
    if not mist_token():
        mist: dict[str, Any] = {"product": "mist", "access": "unknown", "login": "missing"}
    else:
        async with mist_client() as client:
            response = await client.get("/api/v1/self")
            response.raise_for_status()
            mist = mist_report(response.json())
    mist["server_gate"] = {"flag": "--read-only", "state": "off" if READ_ONLY else "on"}
    return {"contract": ACCESS_CONTRACT, "products": [mist]}


def main(argv: list[str] | None = None) -> None:
    """Start the server on stdio. --read-only keeps every change off."""
    global READ_ONLY
    parser = argparse.ArgumentParser(
        prog="{{name}}",
        description="The {{name}} MCP server.",
    )
    parser.add_argument(
        "--read-only", action="store_true", help="never send a change (read once at start)"
    )
    READ_ONLY = parser.parse_args(argv).read_only
    server.run()
