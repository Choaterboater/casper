# 100. An app's server for a product Casper already has

Date: 2026-11-11. Status: proposed. Extends 77 (an ACP client hands Casper its tools) and 89 (an ACP app forwards its
own MCP servers); changes neither. The app is about to hand Casper its bundled network server: casper-network-mcp,
started with `--read-only` and served over the app's loopback http listener. Until now the only overlap check was by
name (`acp-<name>` never replaces a server from your files), so with your own network server connected the AI saw two
routers to the same product, two "Casper's own network server; use it first" lines and the several-routers line.

## Decision

- **When Casper already has the server, the app's copy isn't used.** An app's server (scope `client`) whose preset,
  found by its definition or its tool list, is the same as one of your own servers' is left out of the catalog: no
  tools, no `find_capability` hit, no line in the fixed prompt. A call to it is not executed
  (`server not used: Casper has its own Network server`).
- **Yours counts while it is approved for this session.** It connects by itself (My MCP servers, or remembered), or
  you connected it, or a project server you reviewed. That is known at the start, so yours wins even when it
  connects after the app's. One you disconnect, never approved (an unreviewed project file, My MCP servers off and
  not remembered) or disabled leaves the app's in use. An approved one that fails to start still counts: Casper does
  not swap servers back and forth while yours reconnects.
- **Order.** Your own server known by its definition (the normal set-up, Casper's own network server) is known at
  once. A look-alike known only by its tool list is known once it has connected; until then the app's is used, and it
  leaves the catalog as soon as yours shows its tools.
- **One note.** `[acp] The app's MCP server acp-network is not used: Casper has its own Network server.`, written once
  per app server and session, where the other `[acp]` server notes go (stderr in `casper acp`). `/mcp` shows
  `not used: Casper has its own Network server` on its row, and `/mcp detail` a `Not used:` line.
- **The app's server still connects.** Its tool list is the only way to know which product it is, and keeping the one
  loopback connection costs little.
- **No off switch.** The only effect is to drop a copy of a product you already have. You already choose which copy
  wins: `/mcp disconnect` yours, or `disabled: true` in your file, and the app's is used; `acp_mcp: off` drops all of
  the app's servers. A switch to keep both would only bring back two routers to the same product.

## Guard rails

- Different products stay separate: your `hpe-networking-mcp` next to the app's casper-network-mcp keeps both.
- The name rule of 77 is unchanged: an app's server never replaces a server of the same name from your files.
- Only your own server's approval decides, never the app: nothing the app sends can hide your server.

## A finding

The app's copy of a product your approved server covers offered to the AI, or in the fixed prompt; the note written
more than once for one server; the app's server hidden while yours is disconnected, disabled, never approved, or a
different product.
