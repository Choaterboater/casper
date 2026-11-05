# 76. Casper speaks ACP: apps and editors drive the real Casper

Date: 2026-11-04. Status: proposed. Extends 51 (walk-away tasks: a box answered by someone other than the terminal).

## Decision

`casper acp` is an [Agent Client Protocol](https://agentclientprotocol.com) agent on stdin and stdout (JSON-RPC 2.0,
one message per line, protocol version 1). An app or an editor that speaks ACP (Casper Desktop, Zed, JetBrains) runs
the real Casper engine, with its checks, receipts, trust, sandbox and MCP consent, instead of a copy of them that has
to be kept in step.

- **Each prompt runs as a one-shot run does, with a person answering.** `session/prompt` runs the prompt as
  `casper --json "<prompt>"` runs it: the same trust (the folder counts as trusted, as for scripts), the same sandbox
  default (on where one runs), the same checks, proof and receipt. Because the client's person answers the boxes, the
  defaults that a one-shot run leaves off because nobody can answer are the terminal session's: the request checklist
  is on for code changes (implement, fix, test) and off for questions, docs, reviews and read-only requests, and
  `showPages: ask` asks once a session. An explicit `verification.checklist` or `showPages: on|off` wins, as in the
  terminal. `--model`, `--effort`, `--verify`, `--no-verify`, `--no-sandbox`, `--allow-*` and `--max-turns`
  go before or after `acp` and apply to every session.
- **Sessions.** `session/new` starts a new conversation in the client's folder (`--continue` and `--resume` pick an
  earlier one, as for a one-shot run); its ID is Casper's conversation ID. `session/load` opens a saved conversation and
  replays the person's earlier requests. Each session runs in a Casper process of its own, so sessions run side by side
  without sharing a folder or a sandbox.
- **Updates.** The events behind `casper --json` become `session/update`: the model's text (a line at a time), its
  tools as tool calls, Casper's stages (task, checks, proof, review…) as the plan, and each check Casper ran as a step
  with its result. `session/cancel` is the same stop as Ctrl+C: work stops and changes made so far stay.
- **The receipt is the last message**: the text a person reads, with the facts as data in `_meta.casper.receipt`
  (outcome, verdict, changed files, checks run, checks not run with why, and the whole `--json` receipt). The prompt's
  reply carries the same data.
- **Approval boxes go to the client.** The boxes a one-shot run must refuse (a write outside the project, a new host,
  reaching another machine, an MCP change or a network device write, the MCP and skill add boxes, a server's question)
  go out as `session/request_permission`, with the box's own choices in its order, the safe one first (`No` is
  `reject_once`; `Yes, this once` is `allow_once`; a yes for the session is `allow_always`). The screenshot question
  (`Show them to the AI…?`, `No` · `Yes, show the AI the pages`) is one of them: only a picked Yes sends the pictures,
  and the answer holds for the session.

## Guard rails

- Nothing in `casper acp` answers a box. A picked choice is the only yes. A refusal, an error reply, `cancelled`, a
  cancelled prompt, a closed connection or no answer in 30 minutes is No, the same result a one-shot run gives today.
  A client that drives Casper with nobody watching (a benchmark) answers No and gets one-shot behaviour, except for
  the checklist on code changes; `verification.checklist: false` turns that off.
- Typed secrets never cross: an ssh, sudo or `casper_secret` box and a login's hidden prompt need Casper's own
  terminal and are refused here, as on a walk-away job. The AI's own questions (the ask tool) stay off, as one-shot.
- Every update, permission request and receipt goes through the `--json` redaction and then hides the exact values of
  the user's own secrets (logins, saved keys, secret-looking variables), a line at a time so a value split across two
  chunks is hidden whole.
- The client's `mcpServers` are not connected: an MCP server reaches Casper only through Casper's own consent
  (`~/.casper/mcp.json` stays private and unchanged). `mcpCapabilities` says so (none).
- No ACP authentication: Casper uses its own sign-in.

## Not done yet

- The client's own MCP servers, images in prompts, session modes and `session/list`.
- Replaying the model's earlier answers on `session/load` (only the person's requests are replayed).
