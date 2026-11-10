# 95. Commands while planning, and commands that read private places, ask first

Date: 2026-11-08. Status: proposed. The owner's call: Casper must not refuse what Claude Code and DeepSeek Harness
(Standard mode) ask about or allow by default, and each such behaviour gets a switch, on by default. This changes two
earlier choices:

- Choice 1 of [the deliberate choices](../0002-deliberate-choices.md) (the sandbox off by default): its guard rail "a
  command that names a private place is refused before it runs" and its finding "a command naming a private place
  runs" now hold only where Casper can't ask, or with `private_commands: off`.
- [Decision 82](82-an-acp-app-sets-casper-access.md) ("No box is asked" while Read only) and
  [decision 84](84-an-acp-app-reviews-and-builds-casper-plan.md) ("The planning gate is unchanged"): a shell command
  that is not a look command now asks while planning or Read only, with `plan_commands: off` keeping the refusal.

Those files are not edited here; this decision is the one to read.

## What the other tools do

- Claude Code's plan mode prompts for a Bash command outside its read-only set; it does not refuse it. Its
  `sandbox.filesystem.denyRead` is opt-in and applies only with its sandbox on; no default rule refuses a command
  that names `~/.ssh`. Plan mode and bypass are separate modes, so a bypass does not answer plan-mode prompts.
- DeepSeek Harness runs Read only commands in a read-only sandbox; a blocked one escalates to workspace-write through
  its approval card (Allow once / Reject). Its plan mode leaves the sandbox mode and approval alone. Its shell has no
  private-path refusal.

## Decision

- **`plan_commands: on | off`**, unset meaning on, in your own config only (`~/.casper/config.yaml` or your own
  profile; a project file is refused, as `routine_commands` is). /settings: **Commands while planning**, in Commands &
  checks. While planning, or while an app set Read only, a bash command that is not a look command goes on to the
  shell, which asks before anything else, sandbox on or off. The AI's bash command is read as bash only, so `gci` or
  `gc -am wip` is not a look command there. A PowerShell command that is not a look command keeps today's refusal:
  only the bash tool has that box behind it (`casperBashOperations`), so letting it through would run it unasked:
  - Plan: `Run this command? You're planning, and it may change files before you choose Build.` with the model's
    line and the command, `1 No · 2 Yes, this once · 3 Yes, for this session` (this exact command while planning).
  - Read only: `Run this command? The app set Read only, and it may change files.` with `1 No · 2 Yes, this once`
    only; in an ACP app it is a card (reject_once / allow_once). An app's Read only gets this box also while its plan
    option is on. Read only lets through only this box, the private box below, the Reach or GitHub login box of
    any command, the `Run this command?` box of a look command that reads outside the project with the sandbox off
    (without `Yes to everything`: Read only is not Don't ask), and the new-host and write boxes of a sandboxed command
    you said yes to while it runs; every other box is still No without asking (decision 82).
  - A yes runs the command as Build would: no second "Run this command?" box (a machine it reaches, a new host or a
    write outside the project still asks, in Read only too), and in the sandbox the project is writable for that one run, as DeepSeek's escalation to
    workspace-write is. Look commands keep the read-only project. A file that changes is still named
    (`– Changed while planning: …`).
  - No: `Not run: the user said no to this command while planning. Don't run it again; plan without it or ask the
    user.` (or `…while Read only…`).
  - Off, or a run that can't ask (one-shot, `--json`, no shell box): today's refusal, word for word. What the model
    and the app read about Read only and planning says "asks first or refuses", or follows the switch, so it holds
    either way.
  - Edits, writes, `lsp`'s rename, services, the browser, builders and MCP changes keep today's refusal: they are not
    shell commands.
  - The AI's `ask` question, `lsp`'s lookups (diagnostics, symbols, definitions, references) and the reader
    (`casper_read_untrusted`) run while planning and Read only: they change nothing, as Claude Code's plan mode allows
    AskUserQuestion and LSP and DeepSeek's Read only allows reads. Their private paths ask the private box below, and
    the reader's command source must be a read-only command and its MCP source goes through the broker.
- **`private_commands: on | off`**, unset meaning on, your own config only. /settings: **Commands that read private
  places**, in Privacy & sign-ins. With the sandbox off, a shell command (or an ad-hoc service start) that names a
  private place, to read, write or delete there, asks `Run this command? It uses ~/.ssh, which is private (keys and
  logins).`, with the model's line
  and the command, `1 No · 2 Yes, this once · 3 Yes, for this session` (this exact command). A yes runs it with your
  permissions, its output scrubbed as any command's, and asks no second box, the planning box included. No: `Not run: the user said no to
  reading ~/.ssh.`, with the machines your ssh config names for `~/.ssh` (decision 22). The detector,
  `privatePathCommand`, is unchanged.
  - The AI's `read`, `grep`, `find`, `ls` and `lsp` into a private place (or `grep`/`find` over a folder that holds
    one) ask the same box in their own words: `Read ~/.ssh/config? ~/.ssh is private (keys and logins).`, `Search
    ~/.config? It holds ~/.config/gh, ~/.config/gcloud and ~/.config/hub, which are private (keys and logins).` (every
    private place a yes opens; past three, `and 38 other private places`); No: `Not read: the user said no to reading
    ~/.ssh/config.` Its `edit` and `write` ask `Change ~/.aws/config? ~/.aws is private (keys and logins).` (one
    session yes covers both), and no outside-write box follows a yes, as the shell's `>> ~/.aws/config` gets only
    the private box. The write is still recorded as one outside the project: the receipt's `Wrote outside the
    project` line names the file, and the outside-change snapshot is taken before it. Claude Code and DeepSeek Standard ask before a read or write outside the workspace; DeepSeek
    has no private-path refusal. Their text is `fileToolGate`'s, word for word, where it can't ask. These tools
    run in Casper's own process, not in the sandbox, so they ask with the sandbox on too (`asksPrivateFile`), as
    Claude Code asks whatever its sandbox says. An edit or write in `~/.ssh` asks in the same box (`Change
    ~/.ssh/config? …`), as the shell's `>> ~/.ssh/config` does and as Claude Code asks before an edit outside the
    workspace (the owner's call). An edit or write where the private place is also Casper's own or git's
    (`~/.casper`, a `.git` folder) keeps that separate refusal. The yes answers only that the place is private: a
    write the outside-write rules never offer for another reason (a system folder such as `/etc`, git's own files, the
    project's `sandbox.denyWrite`) is still refused after it, so a project's `sandbox.denyRead` naming such a path
    never turns it into a one-box write. `lsp` asks only for a private file inside the
    project: outside it the LSP layer refuses the call anyway. The reader's `casper_read_untrusted` with a `path`
    asks as `read` does (the same session yes).
  - A read-only helper's (explorer, reviewer) read asks in the session's box too, named for it (`Helper explorer:
    Read ~/.ssh/config? …`), after its own gate; Claude Code sends a foreground helper's prompts to the person.
  - A builder's command or read asks in the session's box under its name (`Builder 2: Run this command? It uses
    ~/.ssh…`), as its other commands do; Claude Code's foreground helpers send their prompts to the person too.
    An app over `casper acp` answers a `/crew` builder's boxes too, but while it set Read only that builder asks
    nothing, as before: its boxes are No without a card, and its commands that need a yes are refused (decision 82).
  - While an app set Read only, this box is let through as a card, as the plan box is.

## Guard rails

- Both boxes are No first, and Enter is No. Neither is answered by `/permissions all`, "Yes to everything this session"
  or auto mode's judge, as an app bundle's box is not: plan and bypass are separate modes, and a private place is
  named in the box. The owner may choose to let `/permissions all` answer the private box instead (Claude Code's
  bypass does); that is a one-line change in `askPrivate`.
- A run that can't ask keeps today's refusal, word for word, for both. So does the sandbox on for a shell command,
  whose `denyRead` hides private places from every command; the AI's file tools still ask, being outside it.
- The AI's `edit` and `write` never change `~/.casper` or git's own files, whatever the switch says (protected places).
  `~/.ssh` asks, in the private box only: No first, never answered by `/permissions all` or the judge.
- A project can't set either key. Off restores today's behaviour exactly. A project's `sandbox.denyRead` adds private
  places, but the private box's yes never opens a write the outside-write rules refuse for another reason.

## Findings

- Not a finding: a command naming a private place runs after the person said yes in its box, or a non-look command
  runs while planning after a yes.
- Not a finding: the AI's edit or write in `~/.ssh` after a yes in its private box.
- A finding: either runs with no box while someone could answer, a yes in the private box lets the AI write in a
  system folder or a place the project's `sandbox.denyWrite` names, a `/crew` builder's box reaches an app that set
  Read only, a box defaults to yes, `/permissions all` or the
  judge answers one, a project file turns one on or off, or the AI's edit or write changes `~/.casper`.
