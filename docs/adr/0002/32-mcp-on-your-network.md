# 32. An MCP server on your own network may use plain http

Date: 2026-10-22. Status: accepted (merged 2026-10-22 in #473).

## Decision

An MCP server at an address (`/mcp add <name> <url>`, `casper_mcp_add`, or a `url` in any MCP file Casper reads) may use
plain `http://` when its host is this computer or your own network:

- `localhost`, `127.0.0.0/8` and `[::1]`, as before;
- a private address: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10` (shared address space, used by
  Tailscale) and `fc00::/7`;
- a name ending in `.local`, `.lan` or `.home.arpa`.

Everything else still needs `https://`. A `host:port` typed with no `http://` or `https://` is read as an address and
Casper says the line to type, instead of trying to run it as a program.

## Why

Home-lab and office tools (network tools, Home Assistant add-ons, a model server on a NAS) serve MCP over plain http
on a private address, with no certificate. Before, the only way in was a bridge program such as `mcp-remote`, and the
AI, told "https or localhost", suggested editing the config file, which had the same rule.

## Guard rails

- Link-local addresses (`169.254.0.0/16`, `fe80::/10`), where cloud metadata answers, and names such as
  `metadata.google.internal` still need `https://`, which metadata endpoints don't serve.
- A public address or name still needs `https://`.
- The rule is checked on the address as written; a name is not looked up, so only the reserved home-network suffixes
  count as yours.
- Adding a server still goes through the same paths: `/mcp add` is yours alone, `casper_mcp_add` always asks
  ([decision 29](29-the-ai-adds-mcp-servers.md)), and a project file's server connects only through `/mcp connect` and
  its review.
- Traffic to such a server is not encrypted; anyone on that network can read it. Headers you put in the entry go in
  the clear too.
