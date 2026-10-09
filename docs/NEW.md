# Start a new project

`casper new` builds a new project on your machine with no model: zero tokens. It runs the real
init tool (`uv init` or `bun init`), lays a bundled template over it, adds the dev packages, runs the
project's own checks once, and makes a first commit with your own git identity.

## Four ways in

| Where | What happens |
| --- | --- |
| `casper new` at a terminal | Asks "What are you building?" (numbered kinds, My own first: an empty folder for anything you describe) and "Name it? (Enter for my-tool)", builds `~/Projects/<name>`, then opens Casper there. Typing what you want instead ("a nightly backup of my switch configs") picks the kind it reads as (or an empty project), names it from your words, and runs your words as the first request there. `casper new <name>` skips the name question; a lone kind word (`casper new web-app`) picks the kind and asks only the name; `casper new <template> <name>` asks nothing. `casper new --help` lists every kind. |
| `casper` in an empty folder | Asks nothing: the prompt is there at once. Your first request that fits a template ("build a NOC dashboard", "make an MCP server for Mist") builds that template right there, with no question and one plain line first: `[new] Using the NOC dashboard template here (installs packages, first commit). To skip a template, say "from scratch" in the request, or turn it off in /settings (Starter templates).` The folder's own name is the project name when it is a valid name; otherwise the template goes in a subfolder with its usual name. Any other request ("make me a todo app in python", "build something") goes straight to the model, which builds it in the empty folder. A one-shot or `--json` run builds nothing and prints the command instead. |
| `casper` from your home folder or a drive root (`C:\`, `/`) | Casper opens right there and asks nothing. One line says where it opened and the command that opens the project you last worked in (`casper ~/Projects/myapp` when there is none yet; on Windows the real path), and `casper new` starts a new project. These folders are broad, so the AI can see and write across all of it: open a project folder when you want it kept to one. |
| `casper` in any other folder | Opens exactly there, with no question. A folder that only holds projects prints one line, such as "This folder holds 5 projects (aibot, casper, and 3 more). To work in one: casper aibot", when it holds two or more. |
| A build request in a folder that holds other things | In a folder that is not a project and not empty (Documents, say), "build a tool that lists Mist APs per site" asks once, before any model call: "Build this as a new Mist Python project in ~/Projects/mist-aps? 1 Use this folder · 2 Yes · 3 Other kind". Enter keeps this folder, and Other kind lists the kinds after "Use this folder". Typing a name instead of a number (or picking the last row, 4 Other — type your own answer, and typing it) uses that name; typing "yes" builds it and "no" keeps this folder, and a number that isn't a choice asks again. Yes builds it, opens it, and your request goes on there, so its checks and proof run in the new project. It is asked at most once a session, and only before the model has started: a conversation's folder is fixed once it exists. |

`/project new [name]`, `/project new <template> <name>` and `/project new --list` do the same inside a
session (`/new` starts a new conversation, as in other coding agents). Before the
model starts, Casper opens the new project; after, it builds the project and tells you how to open
it (`casper ~/Projects/<name>`), because this conversation stays where it is.

Every question works on the plain terminal too: type the number (Enter picks 1). A one-shot or
`--json` run can't ask. It works in the folder it was started in and prints the command that
would start a project instead, for example
`[new] … To start a project instead: casper new mist-python mist-aps`.

A template built from your first request, or the question above, is the one thing before work for that
request: the plan-first panel doesn't follow it, and no checklist is made.

### Turning the starter template off

The quiet build is on by default. Pick **Starter templates** in `/settings` (it writes
`templates: off` in `~/.casper/config.yaml`) and a request in an empty folder goes straight to the
model, with no template built for you. A project file can't turn it on or off. Say "from scratch" in
a request to skip it for that request only. `casper new`, `/project new` and the question above are your own
commands and still work when it is off.

## Scripts and CI

Without a terminal, `casper new` needs a template. A name is optional: a lone kind word uses that
kind's usual name.

```sh
casper new python-cli ping-tool
casper new web-app
casper new --list
```

| Exit code | Meaning |
| --- | --- |
| 0 | Ready: the checks passed and the first commit exists. |
| 1 | Created but not ready (a check failed, no git identity, inside another repository), or a tool failed and nothing was created. |
| 64 | Usage: a bad name, an unknown template, or a template and name missing where Casper can't ask. |

At a terminal, `casper new` exits 1 when nothing was created (you pressed Esc, or the build stopped
before the folder existed); once the project is open, the session ends like any other.

## What you see

Line 1 is the verdict: `Ready: ~/Projects/mist-aps · tests passed · first commit 3f2a1c0 (template
mist-python v1)`, or `Created ~/Projects/x, not committed: <why>`, or `Not created: <why>`. The first
checks prove the new project runs; they prove no change. The result never says "verified" or
"secure".

- Casper never sets a git identity for you. Without one the project is created but not committed,
  and the result says how to set it.
- A missing `uv`, `bun` or `git` stops everything before a folder is made.
- An existing folder that isn't empty is refused, and nothing is written.
- Downloads come from pypi.org (uv) or registry.npmjs.org (bun). Offline without a cache, the
  folder has the template but no packages; run `uv sync` or `bun install` when you're online.
- The init tools run with a cleaned environment (no `BUN_OPTIONS`, `NODE_OPTIONS`, `VIRTUAL_ENV`,
  `PYTHONPATH`, AI provider keys) and the first checks run without anything named like a secret.

## Templates

`casper new --list` prints them. What each one writes and checks is in
[templates/README.md](../templates/README.md).

## Recorded sample data

Templates that call vendor APIs (mist-python, noc-dashboard, network-mcp) ship sample answers,
not data from your org. Their tests replay them with `--record-mode=none`, so a test never reaches
the network by accident. To record your own, use a read-only token:

```sh
MIST_APITOKEN=... MIST_ORG_ID=... uv run pytest --record-mode=once
```

The `authorization` header is never saved. Recorded answers hold your org's real names and
addresses: look through them before you commit.
