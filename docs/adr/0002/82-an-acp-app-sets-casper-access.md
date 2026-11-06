# 82. An ACP app sets Casper's access

Date: 2026-11-06. Status: proposed. Extends 76 (Casper speaks ACP), 77, 78, 79, 80 and 81, and replaces 76's "Not done
yet" item "session modes". Over `casper acp` the app's access chip (Read Only, Workspace Write, Full access) reached
Casper not at all, and the shell box's "Yes to everything this session" set a switch nothing read over ACP.

## Decision

- **Three modes**, sent both as ACP session `modes` and as the `mode` config option (last, after `model` and
  `effort`), as the spec asks while it moves from modes to config options:
  - `read`, **Read only**: Casper looks and answers. Every change it can see is refused as in a plan turn: write,
    edit, every tool but reads, look commands, read-only helpers and MCP reads; a changing MCP call is refused
    without a box. The sandbox mounts the project read-only and offers no write. No box is asked: an approval box is
    No without asking, one queued behind an open one too, and the sandbox can't ask. Casper offers nothing before the
    work (no checklist, plan-first line, new-project, named-project or network-server offer) and runs no checks; the
    receipt says `Not checked — read only (set by the app)`. The request gets one line telling the model so, for that
    request only.
  - `ask`, **Ask first**: Casper's usual boxes.
  - `full`, **Don't ask**: what `/permissions all` does. Commands, hosts, writes outside the project and other
    machines are Yes for the session. MCP changes, risky kinds, protected places and secrets keep their boxes.
- **`session/set_mode`** and **`session/set_config_option`** with `mode` set it. Unlike a model change, a mode is taken
  while a prompt runs and holds from the next tool call and box; a switch to Read only also closes every open box as
  No (its step ends `→ No (access set to Read only)`). A mode is never saved: a new or loaded session starts at
  `ask`, and the app sets its chip again before the first prompt.
- **Casper's own changes reach the app at once**, mid-prompt too: a typed `/permissions all` or `/permissions ask`,
  and "Yes to everything this session", send `current_mode_update` and `config_option_update`. A change the client
  asked for is not sent back. The app records a Casper-initiated `full` and does not move its own chip on it.
- **One box for the app's own servers.** In `ask`, a server the app says asks for itself (`casper/clientAsks`,
  decision 77) runs its change with only the app's box. When the app's last pick was `full` its preset asks nothing,
  so that server's changes get Casper's change box again. A Casper-initiated `full` keeps the app's box, since the
  app's chip did not move. One box either way.
- `/permissions all` over ACP asks its own box as a card (it had refused: "needs a terminal"), and bare
  `/permissions` offers it there. With Read only set, `/permissions all` says to change the access in the app and
  changes nothing, and `/permissions` names Read only first.
- **`acp_access: on | off`** in `~/.casper/config.yaml` only (a profile or project is refused), on by default, shown
  in /settings as **Apps' access modes**. Off: the app is offered only `read` and `ask`, and a `full` set is refused in
  plain words. A `/permissions all` typed in the chat is the person's own and still works.

## Guard rails

- `full` never turns the sandbox off and never passes what `/permissions all` keeps: MCP changes, risky kinds,
  protected places, secrets and the spend pause keep their boxes. Only the person's pick in the app (or their own
  typed command) sets it; the AI has no tool for it.
- Read only blocks what Casper can see. A shell command Casper reads as a look command, or an MCP tool labelled as a
  read that writes anyway, can still change something, as in a plan turn. Commands the person types are theirs.
- A switch during a prompt holds from the next tool call: a tool already running finishes, and that prompt's checks
  still run as planned at its start.
- Finding, accepted: a client can set `full`, but it could already answer every box Yes (77's finding).
  `acp_access: off` takes `full` away from apps.
- An older app that knows neither modes nor config options sees no change; Casper stays at `ask`.
