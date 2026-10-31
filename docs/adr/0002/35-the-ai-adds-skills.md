# 35. The AI can add a skill, after a yes nothing else gives

Date: 2026-10-23. Status: accepted (merged 2026-10-23 in #485). The box's strictness follows decision 29's
(the AI adds MCP servers); it can be changed at review.

## Decision

Asked for a skill in chat ("add a skill: our lab sites are named <city>-<building>", or one the person points to), the AI
writes its name, description, tags and text and calls `casper_skill_add`. Casper writes the `---` header itself, so the
file always reads back as the skill shown, prints the whole file with every line behind a `│`, and asks:

```text
--- the skill lab-naming: ~/.casper/skills/lab-naming/SKILL.md ---
  │ ---
  │ name: lab-naming
  │ description: Naming rules for lab sites and switches.
  │ ---
  │ Site names are <city>-<building>.
--- end of the skill lab-naming ---
The AI wants to add a skill (its whole text is above):
  name         lab-naming
  description  Naming rules for lab sites and switches.
It goes in ~/.casper/skills/lab-naming/SKILL.md. From then on the AI reads it whenever a request fits it, in every
project, until you delete that folder.
Add the skill lab-naming?
  1 No
  2 Yes, add it
```

Nothing is written before 2. A yes writes `~/.casper/skills/<name>/SKILL.md` and indexes skills again, so the next request
it fits uses it.

## Guard rails

- Nothing answers the box for you: not "Yes to everything" or `/permissions all` (they answer the shell's own questions
  only), not a remembered answer (it offers none), not the AI's ask tool. Enter and Esc are No.
- What lands is what you saw: escape, control, bidi and invisible characters are taken out of the text before it is
  shown, and the file written is the text shown, created only if it is new (never over an existing file or folder).
- Never over a name a skill already has (bundled, yours, the project's or a pack's) or a folder already in
  `~/.casper/skills`. A built-in name stays Casper's.
- Text that looks like a key or a token is refused: a skill is instructions, never keys.
- At most 8 KB of text, so the whole of it fits what a person reads before saying yes; more is a pack (`/pack add`),
  which shows its files in full when you ask.
- A run that can't ask (one-shot, `--json`) writes nothing and says so.
- Offered only from the first request that names a skill, so other requests pay nothing for it; once offered it stays
  for the session, like Casper's other tools.

## Why

The owner asked to say "add a new skill" in chat. A skill is instructions the AI follows in every project from then on,
so it can steer later work the way a prompt can; the box shows all of it and only a fresh key from the person answers.

## A finding

A skill is written before a yes in the box, without its whole text shown first, or over an existing skill or folder; the
box is answered by anything but the person's key; a file holding a key is written.

## Not changed

The AI's own `write` tool can still put a file under `~/.casper/skills` after the usual question for a write outside
the project; `casper_skill_add`'s description tells the AI not to. Making that folder a private place would close it
and is a separate change to the private-places list.
