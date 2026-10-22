# 27. "Yes to everything this session" in the command box

Date: 2026-10-21. Status: proposed (owner's choice; needs the owner's review before merge). Changes decision 1's
shell box from four choices to five; decision 1 is otherwise unchanged.

## Decision

With no sandbox, the AI's shell asks `Run this command?` with `1 No · 2 Yes, this once · 3 Yes, for this session ·
4 Yes, always for this project · 5 Yes to everything this session`. 5 runs the command and turns on what `/permissions
all` does: until you quit, the shell's own questions (commands, hosts, writes outside the project, other machines) are
answered "Yes, for this session" without showing them, and the footer says `asking off`.

Before, the only way there was to type `/permissions all` and answer its box (`1 Keep asking · 2 Stop asking until I
quit`). The owner asked for the choice in the box itself, in the words other agents use (Copilot CLI "approve all",
Claude Code "don't ask again this session", the MCP box's own "Yes to everything on <product>").

## Guard rails

- One key replaces `/permissions all`'s second question: picking 5 is the yes. It is the last choice, never the default:
  Enter and Esc stay No, typed words stay No, and only a person answering a shown box can pick it. The AI can't.
- Session only, in memory: never saved, never read from a project file; `/permissions ask` or quitting ends it.
- Everything `/permissions all` leaves alone stays: protected places and secrets, device writes and their boxes, the
  ssh password box, the spend pause, checks outside the sandbox, GitHub-login commands, and the sandbox itself where
  one runs (only questions are answered).
- A run that can't ask never sees the box, so it still refuses (`--no-sandbox` is the flag for one run).
- Only the shell box offers it; the host, write, other-machine, GitHub-login and check boxes keep their choices.
