# 45. Approval boxes ask with three short rows; "always" moves to the Next row

Date: 2026-10-29. Status: accepted (merged 2026-10-30 in #544). Changes decision 1's
shell box and decision 43's note row (No takes the note), and keeps decision 27's row that decision 47 removed (as
row 4). Decisions 1, 43 and 47 are otherwise unchanged.

**What:** the yes-word approval boxes (a shell command with no sandbox, a host, another machine, a write outside the
project, your GitHub login, checks outside the sandbox) ask with `1 No · 2 Yes, this once · 3 Yes, for this session`
and nothing beside the rows: no explanation column, no `Enter to choose · Esc to skip` hint under them.

- **No takes the note.** Picking No (`1`, or Enter on it) opens a line in the No row (`1. No — …`). An empty Enter is a
  plain No; words there go to the AI with the No, as the note row did. Esc goes back to the list; Esc on the list skips.
- **"Yes to everything this session" stays, as row 4, on the `Run this command?` box only.** Decision 47 removed it
  when auto mode's judge came; the owner kept it on purpose: "still wanted to say yes to everything or automode or
  whatever without going to /permissions all". With auto mode the box shows only when the judge asks, or when auto mode
  is off or the folder isn't trusted, so row 4 is the one-key way out from there. It does what `/permissions all` does,
  with the same exclusions. The other boxes keep three rows. `stop asking` (or `don't ask again`) typed alone at the
  prompt opens the `/permissions all` box, as if typed.
- **"Yes, always for this project" leaves the boxes.** A 3 is remembered for the session, and the Next row after the task
  offers it once: `Always allow npm test in this project`, which runs `/allowed keep <n>`. That saves exactly what the
  old fourth row saved (the exact command, the host, the machine, the folder, the GitHub kind, checks outside the
  sandbox), in the same private place. The lab checks box keeps its own "always" row; the MCP change box is unchanged.

**Why:** the owner: "isnt this way to many options to give" and "most people will only select 3 of them". The shell
box had six rows with an explanation beside each. Claude Code and Codex ask with three rows and one "remember" choice;
Gemini CLI and Aider ask with three or four. Keeping No first and Enter on No is Casper's own rule (decision 1).

**Guard rails:**

- No stays first and Enter never says yes: Enter on No opens the note line, and Enter there is No.
- Typed text never approves. A note, even one that spells a granting choice, is a No (decision 43).
- A kept answer is saved only by the person's own key on the Next row or a typed `/allowed keep <n>`; the AI can't run
  it. It covers exactly what the session yes covered: an exact command, never a prefix; a folder only where the write
  box could have offered it (never one file, never a protected place, checked when you said yes).
- Each session yes is offered once; nothing is kept unless picked. `/allowed forget` and `/sandbox forget` take a kept
  answer back as before.
- A GitHub command that changes things on GitHub or your checkout, or types its own address, still offers 1 and 2 only
  and is never offered to keep.
- Row 4 keeps decision 27's limits: session only, never saved, Enter and notes stay No, only a person answering a shown
  box can pick it, and a run that can't ask refuses. `stop asking` only opens the `/permissions all` box (Keep asking
  first); the person's own answer there sets it.

**A finding:** a yes-word box offering "always for this project" again; Enter, Esc or typed words resolving a box to a
yes; a Next row keep that saves more than the session yes covered (a prefix, a single file, a protected folder); or a
keep run by anything but the person.
