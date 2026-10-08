# Packs

**What this is:** a pack is one folder of skills someone else wrote, with a small `pack.yaml` that
names them. You add it with `/pack add`; Casper shows you the whole pack first and adds nothing until
you say yes. After that its skills work like your own (see [CONFIGURATION.md](CONFIGURATION.md#skills)):
the AI gets a skill's text only for a request it fits.
**When you'd use it:** a team or a vendor shares how they work (how to write their reports, how to
use their API) and you want Casper to use it without copying files around by hand.

A pack costs nothing until it is used: nothing is added to the system prompt or the tool list, so a
pack of 20 skills adds 0 bytes to a request no skill fits.

## A pack folder

```text
writing-basics/
  pack.yaml
  README.md          optional
  LICENSE            optional
  skills/
    drafting/
      SKILL.md
      examples.md    part of the drafting skill
    proofreading/
      SKILL.md
```

```yaml
name: writing-basics
version: 1.2.0
description: Short, plain help with letters and notes.
skills:
  - skills/drafting
  - skills/proofreading
```

`pack.yaml` has these four fields and no others. A field Casper doesn't know refuses the pack (it is
not skipped), so a pack made for a later Casper never installs here with part of it left out.

- `name`: 1-64 lowercase letters, numbers or single hyphens, like a skill's name. A name Windows
  keeps for itself (`con`, `nul`, `aux`, `prn`, `com1`, `lpt1` and so on) is refused on every system.
- `version`: three numbers, like `1.2.0` (a suffix such as `-beta.1` is fine).
- `description`: the author's own line, 1-300 characters. The add box shows it in quotes as theirs.
- `skills`: 1-64 skill folders inside the pack. Each holds a `SKILL.md` in the usual skill format.

**What may be in the folder.** `pack.yaml`; a `README.md` or `LICENSE` (`LICENSE.md`,
`LICENSE.txt`) at the top; and anything inside a listed skill folder, which counts as part of that
skill (its notes and examples). Any other file refuses the pack. A `.git` folder at the top and the
`.DS_Store`, `Thumbs.db` and `desktop.ini` files systems leave are skipped, in a folder or a GitHub
commit: never copied or shown.

**What the files may be.** Plain UTF-8 text files only: no links, no other kinds of files. Names use
letters, digits, `.`, `-`, `_` and spaces, and don't start with a dot. At most 200 files, 256 KB each,
2 MB in all, 8 folders deep. A file with a character you can't see (a control or escape character, a
right-to-left override, a zero-width space) refuses the pack, because the AI would read text you
couldn't.

## Commands

| Command | What it does |
| --- | --- |
| `/pack add <folder>` | Add a pack from a folder on this computer (a full path, `~/…`, or a path from the project folder) |
| `/pack add https://github.com/<owner>/<repo>@<commit>` | Add a pack from GitHub, at one commit ([below](#from-github)) |
| `/pack list` | The packs you added, where from, and any that aren't used and why |
| `/pack remove <name>` | Take a pack out (its record, then its folder) |

Only you can type these. The AI has no tool that reaches them, and a `/pack add` line in the AI's
reply is just text.

## The add box

Every word of the box is Casper's, counted from the files themselves; only the quoted line is the
author's:

```text
Pack writing-basics 1.2.0 from github.com/example/writing-basics
The author says: "Short, plain help with letters and notes."
Skills: drafting, proofreading
Files: 5, 6 KB in all. Casper reads them as text; the AI gets a skill's text only when a request fits it.
Add pack writing-basics from github.com/example/writing-basics?
It brings 2 skills. Nothing else runs.
  1 No
  2 Yes, add it
  3 Show me what's inside
```

Enter is No. `3` prints every file in full, each under its name with every line behind a `│`, so
nothing in a file can pass for the line that starts the next one. Then it asks again with
`1 No · 2 Yes, add it`. Escape characters, controls and right-to-left characters in what is shown
are taken out, so the author's words can't clear the screen or reorder the line. A run that can't ask
you (one-shot, `--json`) adds nothing: `Adding a pack asks you first, and this run can't ask. Nothing
was added.`

**What lands is what you saw.** Casper copies the files into a staging folder in `~/.casper/packs`,
reads that copy back with the same checks, and shows you that copy. On `2` it checks every file's
sha256 once more, then swaps the copy in with one rename; if anything changed while the box was
open, nothing is added.

**Adding again is the update.** `/pack add` from the same source (the same folder, or the same GitHub
repository at another commit) shows the same box with what changed: `Changed since you added it: …`,
`New: …`, `Gone: …`, and both versions. If nothing changed, it says so and adds nothing. A pack with
the same name from somewhere else is refused; `/pack remove` it first. Casper never updates a pack
by itself.

**Names are first come.** A pack whose name, or the name of one of its skills, is already used by
any skill (yours, a project's, another tool's, another pack's), by an MCP server, or by a skill built
into Casper is refused. If a skill with the same name turns up later, the pack's skill is the one
that isn't used, and `/skills diagnostics` says so.

## From GitHub

```text
/pack add https://github.com/example/writing-basics@4f2c1a9e8b7d6c5f4e3a2b1c0d9e8f7a6b5c4d3e
```

- **One commit, in full.** The 40-character commit id after `@`. A branch or tag can point somewhere
  else tomorrow, so neither is taken.
- **https and github.com only.** Any other address, host, port or a login in the link is refused.
  For a pack from somewhere else, download it and add the folder.
- **Public repositories only.** git never asks for a login.
- **git runs with nothing of yours.** Your git settings and the system's are not read (no `GIT_*`
  from your environment either), hooks point at an empty folder, every protocol but https is
  refused, and redirects are not followed. It fetches that one commit, without history, tags or
  submodules, into a temp folder. Nothing is checked out: each file is read straight from git's
  objects, so no filter, attribute or Git LFS step runs (a file stored with LFS refuses the pack, as
  do links and submodules). The files then go through the same checks as a folder.
- **Where the shell sandbox runs** (macOS and Linux with the sandbox on), the fetch runs in it and
  reaches only its listed hosts. **On Windows**, which has no sandbox (see [WINDOWS.md](WINDOWS.md)),
  and with the sandbox off or not started, the fetch runs outside it with the same git settings, like
  a `/references add` download.
- Needs git: without it, `/pack add` says so and suggests adding a downloaded folder instead.
  Fetching stops after 2 minutes; Ctrl+C stops it sooner.

## After you add one

- The pack's files are in `~/.casper/packs/<name>/`. What you saw (source, version, skill folders and
  every file's sha256) is in `~/.casper/packs.json`, with a keyed hash made with
  `~/.casper/packs.key`, so a record written by anything other than `/pack add` doesn't count.
- `/skills` lists its skills with the source `pack`. They are used while every file is still what
  you saw. If any file changes, the whole pack stops being used until you look again: `/pack list`
  says `not used: its files changed since you added it`, and `/pack add` from the same source shows
  the box with the changes.
- Its skills count toward the same limits as all skills: at most `skills.maxActive` (6) per request
  and 64 KiB of skill text per request.
- The AI's tools can't open the pack's folder or its record (they are private, like
  `~/.casper/skills-trust.json`). With the sandbox on, neither can its shell, and the shell can't
  write anywhere in `~/.casper`. Without one (always on Windows) the shell can, but a changed pack
  file stops the pack and a record needs the private key to count (see
  [SECURITY.md](SECURITY.md#what-is-not-held-back)).
- A pack's skill reaches the AI only as its `SKILL.md` text, in a request it fits; the skill's other
  files are for you to read in the box.
- `/skills block <id>` stops one of its skills. `/skills trust` doesn't apply: a pack is reviewed as a
  whole, in the add box.

## Turning packs off

`/settings` → Packs, or in `~/.casper/config.yaml` (or a profile you chose):

```yaml
packs: off # default on
```

The packs stay in `~/.casper/packs`, no skill of theirs is used, and `/pack add` adds none. A
project file can't set `packs:` at all. See [CONFIGURATION.md](CONFIGURATION.md#packs).

## What a pack can never do

- **Run anything.** No install step, script, hook or command; files are copied as text and never
  made executable.
- **Bring anything but skills.** No slash commands, MCP servers, tools or settings.
- **Arrive without you.** A repository, a project file, a profile a repository picks, or the AI can't
  add a pack or turn packs on.
- **Change on its own.** No automatic updates; a changed file stops the pack until you look again.
- **Stand in for another skill.** Your skills, a project's skills and Casper's built-in skills keep
  their names.
- **Reach outside its folder.** Links, `..` and absolute paths are refused.
- **Cost tokens by being there.** Nothing is added to a request until a request fits one of its
  skills.
