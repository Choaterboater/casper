# 91. An app may close an idle Casper

Date: 2026-11-07. Status: proposed. Extends 76 (Casper speaks ACP), 77 and 82, and uses 89's model rule. An app that
runs `casper acp` keeps one Casper process per open conversation, each with its runtime, its MCP servers and its
sandbox, for as long as the app runs. A conversation nobody has touched for an hour still holds all of that, and the
app can't tell a Casper that sits idle from one whose dev server or slow command is still at work.

## Decision

- **`_casper/idle`**, an ACP extension request with `{sessionId}`, routed to the session as a prompt is. Its reply is
  `{idle, running, reason?}`:
  - `running` lists what is still at work, by kind only, in this order: `dev server`, `command`, `debugger`,
    `helper`, `checks`. The browser for page checks is not counted: closing it loses nothing.
  - `idle` is true only when `running` is empty, no prompt runs and no model or effort change is being applied.
  - `reason: "busy"` during a prompt or a model change; `reason: "off"` when the setting is off.
  - An unknown session gets -32002, as every session request does. An older Casper answers -32601, which the app
    reads as not idle.
- **End notes count as running.** A background command that has ended but whose note for the AI is still being
  written into the conversation is still a `command`; a helper whose cleanup has not drained is still a `helper`.
  Closing then would lose the note the AI is meant to read.
- **The app decides.** Casper never exits by itself. The app asks after its own idle time, closes the process on
  `idle: true`, and reopens the conversation with `session/load` for the next prompt. On that load the conversation's
  own model and effort come back (decision 89).
- **`acp_idle_exit: on | off`** in `~/.casper/config.yaml` only (a profile or project is refused), on by default,
  shown in /settings as **Apps close idle Casper**. It is read again from your file for each check, so a change
  reaches a running session from the next check. A file Casper can't read answers off.

## Guard rails

- The reply never holds a name, a command's text, an id, a path or a secret: only the fixed kinds.
- What a session allowed for itself ends with the process: "Yes, for this session" answers, and the access mode the
  app or a typed `/permissions all` picked. The reopened Casper starts at Ask first with no session yeses, as a new
  session does, and asks again. That is the safe direction: a close never widens what Casper may do.
- Off keeps every Casper open until the app closes it, as before. A project can't turn closing on or off.
- Finding, accepted: an app could already end the process at any time by closing its stdin; this request only lets
  it pick a moment when nothing is lost.
