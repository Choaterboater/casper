# 77. An ACP client's MCP servers connect for its session

Date: 2026-11-05. Status: proposed. Extends 76 (Casper speaks ACP). It replaces 76's guard rail "The client's
`mcpServers` are not connected" and its "Not done yet" item "The client's own MCP servers".

## Decision

- **The servers a client lists in `session/new` or `session/load` connect for that session only, with no box.** They
  load as scope `client`, named `acp-<name>`, after the servers Casper's own files define, and they connect at the
  start whatever My MCP servers (`mcp_autoconnect`) says. `initialize` says `mcpCapabilities: { http: true, sse: false }`.
  Each gets one line on stderr: `[acp] The app's MCP server acp-app connects for this session.`, or why it is not
  connected. A session that does not open (a failed `session/load`) closes them with its app, and the process takes a
  `session/new` next.
- **Reads run without asking; a change asks.** A tool whose `readOnlyHint` is true and whose name agrees runs without a
  box, as for any MCP server. Any other call asks in Casper's change box, sent as `session/request_permission`.
- **`casper/clientAsks`: the client asks for itself.** A loopback (`127.0.0.1`, `::1`, `localhost`) http server or a
  stdio server whose entry carries `_meta: { "casper/clientAsks": true }` means "this client shows its own approval for
  every change on this server". Casper then skips its change box for that server (as for your own server with My MCP
  servers on), so one install shows one box, the app's. The risky-kinds box (delete, firmware, admin) still asks, in
  Casper's box.
- **Pins.** A tool whose `tools/list` entry has `_meta: { "casper/pin": true }`, on a client server, is offered to the
  model directly, whatever the first prompt said, in the order the server lists them: the first right after routers,
  the rest after docs tools, at most 4 a session, inside the cap of 8 direct tools. The first goes ahead of docs, so
  routers and docs together never push out every pin (the app's way in).
- **Calls say which step they are.** A `tools/call` to a client server carries
  `_meta: { "casper/acpToolCallId": "casper-tool-N" }`, the `toolCallId` of Casper's `tool_call` update for the step
  running it, so the client can join its own box to that row. It is left out when Casper does not know it.
- **`acp_mcp: on | ask | off`** in `~/.casper/config.yaml` only (not a profile or a project). `on` is the default.
  `ask` connects the servers and brings Casper's change box back for every one of them (two boxes for an install the
  app also asks about). `off` connects none, says so on stderr, and `initialize` says `http: false`, as before this
  decision. /settings shows it as **Apps' MCP servers**.

## Guard rails

- Memory only. A client server is never written to a file, never remembered (connect consent or risky kinds), never
  given a saved key from `~/.casper/mcp-secrets.json` or a saved network login, and its values get no `${VAR}`
  expansion: they are used exactly as the client sent them.
- Names start `acp-` and never shadow a server from any file Casper reads: a client server whose name a file already
  uses is left out, with a note.
- The URL and name rules of decision 32 hold (https, or plain http only to this computer or a private network; no user
  name, password or `#` in the URL). SSE is refused. A stdio command must be an absolute path; `PATH`,
  `NODE_OPTIONS`, `LD_*` and `DYLD_*` are refused (as for keys, decision 31), and so are headers the connection sets
  (`Host`, `Content-*`, `Mcp-*`, `Cookie`, `Origin`). At most 8 servers, one per name. A stdio server starts in your
  home folder.
- Every header and env value the client gave, and the credential after `Bearer` in one, is hidden in every update,
  permission request and receipt, in Casper's stderr, in `/mcp`, and in the server's results before the model reads
  them.
- `casper/clientAsks` never covers your own, imported or project servers, a server at any other address, or any server
  with `acp_mcp: ask`. It is only read from the client's own entry.
- A client server that is a network product (a preset, by its definition or its tool list) starts with writes off and
  its read-only pins, like any network product, `casper/clientAsks` or not.
- The AI cannot change or remove a client server (`casper_mcp_add` with `replace`, `casper_mcp_remove`): it is in "the
  app that started Casper", and the answer says to change it there.
- No prompt growth: the broker adds tools only when a server is connected, and server `instructions` are not used.

## Why

Over ACP the client's person already answers every Casper box (decision 76). Skipping Casper's change box on a server
the client says it guards changes who draws the box, not who decides, and it avoids two boxes for one install. The
other servers a client lists (an editor forwarding its own) get Casper's box as before.

## A finding

A client could mark a third-party server `casper/clientAsks` and never ask. That same client could as well answer
every `session/request_permission` with yes, so this adds no trust the client did not already have. The risky kinds
still ask in Casper's box, and `acp_mcp: ask` or `off` in your own config takes it back.
