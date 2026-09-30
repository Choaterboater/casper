"""The {{name}} MCP server.

Every tool says whether it changes things (readOnlyHint / destructiveHint). Tools that change
things are only registered when {{env}}_READ_ONLY=false, and there are none yet.

Settings (environment):
  MIST_API_TOKEN      a Mist API token; use a read-only one
  MIST_HOST           the Mist API host (default api.mist.com)
  {{env}}_READ_ONLY   "true" (default) keeps write tools off
"""

from __future__ import annotations

import os
from typing import Any

import httpx
from mcp.server.mcpserver import MCPServer
from mcp.types import ToolAnnotations

ACCESS_CONTRACT = "casper/access-check v1"
READ_ONLY_SWITCH = "{{env}}_READ_ONLY"

# Labels for a tool that only reads. The client sees them; tests check every tool has one.
READS = ToolAnnotations(read_only_hint=True, destructive_hint=False, open_world_hint=True)

server = MCPServer("{{name}}")


def writes_enabled() -> bool:
    """Write tools exist only when {{env}}_READ_ONLY is set to false, 0, no or off."""
    return os.environ.get(READ_ONLY_SWITCH, "true").strip().lower() in {"0", "false", "no", "off"}


def mist_host() -> str:
    return os.environ.get("MIST_HOST", "api.mist.com").strip() or "api.mist.com"


def mist_client() -> httpx.AsyncClient:
    token = os.environ.get("MIST_API_TOKEN", "").strip()
    if not token:
        raise RuntimeError("MIST_API_TOKEN isn't set. Use a read-only Mist token.")
    return httpx.AsyncClient(
        base_url=f"https://{mist_host()}",
        headers={"Authorization": f"Token {token}", "Accept": "application/json"},
        timeout=30,
    )


def mist_access(privileges: list[dict[str, Any]]) -> str:
    """read-only only when every role is read; any admin or write role is read-write."""
    roles = {str(item.get("role", "")).lower() for item in privileges}
    if not roles:
        return "unknown"
    if roles & {"admin", "write"}:
        return "read-write"
    if roles == {"read"}:
        return "read-only"
    return "unknown"


@server.tool(annotations=READS)
async def access_check() -> dict[str, Any]:
    """What the Mist login may do, as Mist itself reports it (GET /api/v1/self). Read-only."""
    async with mist_client() as client:
        response = await client.get("/api/v1/self")
        response.raise_for_status()
        me = response.json()
    privileges = me.get("privileges") or []
    return {
        "contract": ACCESS_CONTRACT,
        "products": [
            {
                "product": "mist",
                "access": mist_access(privileges),
                "identity": me.get("email") or me.get("name") or "api token",
                "role": ",".join(sorted({str(p.get("role", "")) for p in privileges})) or "none",
                "server_gate": {
                    "env_var": READ_ONLY_SWITCH,
                    "state": "enabled" if writes_enabled() else "disabled",
                },
            }
        ],
    }


def main() -> None:
    """Start the server on stdio."""
    server.run()
