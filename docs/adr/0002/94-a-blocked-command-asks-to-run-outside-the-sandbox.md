# 94. A blocked command asks to run outside the sandbox

Date: 2026-11-08. Status: proposed. Extends 76 (Casper speaks ACP), 82 and 85, and changes what the sandbox does when
it blocks a command (76 itself is not edited). A command the sandbox kept from doing something simply failed: on Ask
first, `touch ../outside-file.txt` ended with "Operation not permitted" and no box, in the app and in the terminal.
Claude Code and DeepSeek Harness (Standard mode) both offer to run such a command outside their sandbox, behind a box
the person answers. In both, the model asks for that retry (Claude Code's `dangerouslyDisableSandbox`, DeepSeek's
`sandbox_permissions` with a reason its card shows); Casper asks by itself once the sandbox blocks it, so the box is the
same and the model needs no extra step. The owner's rule: Casper does not block what they allow or ask about by
default, so it asks too.

## Decision

- **When it asks.** A held command that failed, where the sandbox refused something: by its own report (a write, a
  read, a host or any other refusal), or, where it names nothing, by its denial words in the command's output, as
  DeepSeek Harness reads them for the same kind of sandbox: `Operation not permitted` on macOS; on Linux `Read-only
  file system` (bubblewrap mounts what commands may not write read-only) or `Operation not permitted` (its seccomp
  filter refuses Unix sockets, which Claude Code also counts), from any program, on any line. Like
  Claude Code, Casper does not check which file or host it was before it asks. A command that failed with neither
  asks nothing.
- **The box.** `The sandbox blocked it (wanted to write <file>; wanted to read <file>; wanted to reach <host>). Run
  this command outside the sandbox?` with the command below it, in the terminal or as `session/request_permission` in
  an app over `casper acp`, where it names the bash step that raised it (decision 85). Where only the output's words
  count: `The command said "Operation not permitted"; the sandbox may have blocked it. Run this command outside the
  sandbox?`
- **Two choices only:** `No` (`reject_once`) and `Yes, this once` (`allow_once`), as DeepSeek Harness's card. Nothing
  is kept for the session, and the next command, the same words included, is held again and asks again.
- **Yes, this once** runs that one command again, outside the sandbox: the same words, folder and environment, with the
  command's time and its own stall check from then on, as its first run had (values typed in `casper_secret`'s box
  for that command included): a command that may move to the background moves there the same way, and a command
  that was handed the terminal is handed it again. The AI reads the held run's
  output, the line `[sandbox] The user allowed this one command outside the sandbox, so Casper ran it again there. That
  run's output follows; its exit code is the result.`, then that run's output; its exit code is the call's. The
  receipt lists the folders outside the project the sandbox said it wanted to write (from its report, or on Linux from
  the output's `Read-only file system` lines) under `Allowed writes outside the project` (no undo copy).
- **No**, a cancel, an error, a closed connection or no answer leaves the command failed. The AI reads what it read
  before (where the sandbox named it, `[sandbox] Blocked by the sandbox (...).` and the sandbox's "don't retry" line)
  and `The user said no to running it outside the sandbox. Don't retry it or work around it.`, as DeepSeek Harness's No says to
  stop and explain instead of working around it.
- **The access modes** (decision 82). Ask first asks. A plan turn and Read only ask too, but there only look commands
  run at all (any other command is refused before it runs, as before): when the sandbox blocks one, the box is shown
  although Read only shows no other box, as DeepSeek Harness's read-only mode offers its escalation card. Running
  other commands there in a read-only sandbox, as DeepSeek Harness does, is the owner's call and not part of this
  decision. Don't ask (`/permissions all`, the app's Full access chip) runs it
  outside without the box, as Claude Code's bypass mode does; the AI reads `[sandbox] Don't ask is on, so Casper ran
  this command again outside the sandbox.`
- **The off switch** is `sandbox.commands` in your own `~/.casper/config.yaml` (**Blocked commands** in `/settings`;
  `/sandbox` and `/permissions details` say it), as Claude Code's `sandbox.allowUnsandboxedCommands`: `ask` (the
  default) is the box above; `outside` runs it once more outside the sandbox without asking, also where nobody can
  answer and before any write box, and the AI reads that your config says so; `inside` keeps it blocked, Don't ask
  included, as Claude Code's `allowUnsandboxedCommands: false` (the box to allow writes to a folder still asks). A
  project file can't set it.
- **Private places.** Your own `sandbox.allowRead` (`[~/.aws]`; **Readable private places** in `/settings`) takes a
  built-in private place at or inside a folder you name off the sandbox's hidden list and the refusals of the AI's
  file tools, helpers, the untrusted-text reader and dev-service commands, as Claude Code's
  `sandbox.filesystem.allowRead`. Unlike Claude Code's, an entry inside a private place (`~/.ssh/config`) opens
  nothing, and loading the config says so: name the place or a folder holding it. Sandboxed commands still can't
  write an opened place, nor can the AI's `edit` and `write` while the sandbox is on or in its default off-until-asked
  state; with `sandbox: off` (or `--no-sandbox`) they treat it like any place outside the project (no box), except
  protected ones such as `~/.ssh`. A project's own `denyRead` stays. A project file can't set it.
- **A command in the background** asks when it ends, as DeepSeek Harness's background jobs and Claude Code's
  backgrounded commands may escalate; its run outside writes to its job. While a box is open for a command that has
  not moved yet, the call is not moved at its time limit, and a line the person sends while it is open waits: it
  neither moves nor stops the run outside, which then has the command's time afresh.

## Guard rails

- Only where someone can answer: a one-shot run, `--json` or a closing Casper never asks and never runs outside, as
  Claude Code's `-p` and DeepSeek Harness's "unavailable" fail closed, unless your own `sandbox.commands: outside`
  says to. A command the person stopped never asks and never runs outside. A builder's blocked command asks in your
  box under the builder's name ("Builder 2: The sandbox blocked it …"), and on Don't ask runs outside its copy
  without one, as the main session's does and as Claude Code's subagents ask in the main session; a builder with no
  box to ask in (a one-shot run) never asks.
- A git or gh command that failed for want of the GitHub login gets the login hint, which leads to its own yes box. A
  write where every refused folder is one the write box offers asks that box instead ("Allow it?"), as before; where
  that box can't ask (Read only), this one asks where it can.
- A host the person answered No in the host box while the command ran keeps that No, as the write box's No does: a
  command refused only such hosts gets the plain blocked line and "The user said no to reaching <host>", never this
  box, and `sandbox.commands: outside` doesn't run it outside either. A host nobody was asked about (a one-shot run, a
  crew running) is refused as before and asks here.
- Only that command, once. The run outside is not wrapped, and nothing is added to the session's allowed places.
- Finding, accepted: the command runs a second time, so whatever its first, held run did inside the project happens
  again (an append, a counter). The box shows the command, as Claude Code's and DeepSeek Harness's do.
- Finding, accepted: the output's words can come from something other than the sandbox (macOS privacy settings, a
  file's owner, a real read-only disk), or be printed on purpose. The box says they are the command's words and shows
  the command; nothing runs outside without "Yes, this once" (or Don't ask, or `sandbox.commands: outside`, which the
  person turned on).
- Finding, accepted: run outside, a command reads and writes what the sandbox kept from it: a private place
  (`~/.ssh`), a protected one (`.mcp.json`, another repository's `.git/hooks`), your GitHub login, the project during a
  plan turn. On Don't ask that happens with no box, as in Claude Code's bypass mode. `sandbox.commands: inside` keeps
  every blocked command blocked.
