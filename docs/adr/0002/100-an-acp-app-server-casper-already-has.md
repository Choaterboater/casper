# 100. An app's server for a product Casper already has

Date: 2026-11-11. Status: proposed. Extends 77 (an ACP client hands Casper its tools) and 89 (an ACP app forwards its
own MCP servers); changes neither. Two decisions about the same server. The app is about to hand Casper its bundled
network server: casper-network-mcp, started with `--read-only` and served over the app's loopback http listener.
Until now the only overlap check was by name (`acp-<name>` never replaces a server from your files), so with your own
network server connected the AI saw two routers to the same product, two "Casper's own network server; use it first"
lines and the several-routers line.

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

## Decision: a server read-only by its own setting

- **No Yes that can't do anything.** The app's bundled network server runs `--read-only`, and Casper can't restart an
  http server without it. Until now a change still showed the writes box, and its Yes only flipped Casper's flag: the
  server refused the change, `For this session` left a `WRITES:` footer for a server that can't write, and
  `/mcp writes` printed `Writes on`. Now a network product (a preset, by its definition or its tool list) that Casper
  did not pin and whose `access_check` reports every product's write gate off (`server_gate` `state: "off"`) is
  read-only by its own setting. A change on it is refused before any box, with
  `Not executed (Network writes are off: the server runs read-only.)`.
- **Troubleshooting checks still run.** A check the server's own gate lets through (a show command on
  casper-network-mcp) still asks and runs, and a diagnostic still asks; neither turns writes on.
- **Writes can't be turned on.** `setWrites` refuses with
  `This server runs read-only by its own setting. Writes can't be turned on here.`, and `/mcp writes` and
  `/mcp allow` say so with no box. The AI's `find_capability` line says
  `<server>: runs read-only by its own setting; changes are refused. Don't plan changes on it.` in place of
  "every change asks", and `/mcp detail` says
  `Can't pin read-only for this server (it runs elsewhere). The server runs read-only by its own setting; changes are refused.`
- **Not a new gate.** The server would refuse the call anyway; this only takes away a Yes that does nothing. No off
  switch: one could only bring back the no-op box. Who runs the server decides (the app's own setting).

## Guard rails

- Different products stay separate: your `hpe-networking-mcp` next to the app's casper-network-mcp keeps both.
- The name rule of 77 is unchanged: an app's server never replaces a server of the same name from your files.
- Only your own server's approval decides, never the app: nothing the app sends can hide your server.
- Only the server's own `access_check` makes it read-only by its own setting, as only it makes a login read-only. A
  server Casper pinned (its own network server, started with `--read-only`) keeps the change box: a yes restarts it
  without its pins. A server whose gate is on, that reports none, or that is no product Casper knows keeps the box
  too. This touches the change box: owner's review.

## A finding

The app's copy of a product your approved server covers offered to the AI, or in the fixed prompt; the note written
more than once for one server; the app's server hidden while yours is disconnected, disabled, never approved, or a
different product. A change box or a Yes offered for a server that reports its own gate off and that Casper did not
pin; a pinned server, or one whose gate is on or unreported, refused without a box; a troubleshooting check its gate
lets through refused.
