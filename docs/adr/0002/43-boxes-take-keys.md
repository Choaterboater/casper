# 43. Boxes take keys; words go on the row that asks for them

Date: 2026-10-28. Status: proposed (owner's choice; needs the owner's review before merge). Replaces the inline comment
on an approval's No, and letters typed straight into a question's Other row. Decision 27's "Yes to everything this
session" is no longer the shell box's last row: the note row follows it.

**What:** on the rich terminal, an approval box and a question box are picked with keys, as in Copilot CLI, Claude Code
and Codex: a row's number, or ↑/↓ and Enter; Esc skips. Letters typed on the list go nowhere. They don't open a field,
move the highlight or answer the box; one short hint names the keys and the number of the row that takes words
(`Pick with 1-3 or ↑↓ Enter · 3 to tell the AI what to do instead`). Words are typed only after picking that row:

- An approval's last row is `No, and tell the AI what to do instead`. Picking it opens a one-line field. Enter sends No
  with the note (as direction for the task, as the inline comment did), and Esc goes back to the list.
- A question that takes a typed answer keeps its last row, `Other — type your own answer`. Picking it opens the answer
  line, as before. Typing on the list no longer starts an answer there.
- A paste on the list waits as the draft for after the box, as it already did for approvals and pickers. Once a
  field is open, a paste goes into it.

**Why:** on Windows the owner typed `go`, meaning yes, in the approval for an MCP call. It became `1. No — go`, and the
number keys and arrows did nothing until he found Backspace, because a comment pinned the highlight to No and picks
need an empty field. In his words, typing straight into the box "seems wonky". Every other agent he uses prompts with
keys and asks for words only after you pick the option that takes them.

**Guard rails:**

- Typed text never approves anything. A note, even one that spells a granting choice, is a No, and the record says
  `→ No (<note>)`.
- No stays first, and Enter on the default row is No. The note row is a No too, so ↑ from No now wraps to a No row,
  not to "Yes to everything this session".
- Keys pressed just before a box opens (about 0.3 s) are still ignored.
- Ctrl+X still denies an open approval, with or without an open note.
- The plain terminal is unchanged: it reads a typed number, and typed words there are still a No.

**A finding:** a letter typed on a box's list that answers it, opens a field, or moves the highlight; any typed or
pasted text that resolves an approval to anything but No; or a field opened without its row being picked.
