# 44. A folder's own commands run only once you trust it

Date: 2026-10-29. Status: accepted (merged 2026-10-29 in #540). Narrows decision 2 in a folder you haven't trusted.
Replaces "Trust first" in VERIFICATION.md, which said Casper runs a repository's commands without asking and to use
`--no-verify` for code you don't trust.

**What:** the first time a session opens a folder, Casper asks `Trust <folder>? It would run: npm test, npm run lint.`
with `1 Not now · 2 Trust this folder`. Enter and Esc mean Not now. Trust is saved for the folder in
`~/.casper/projects/<name>-<id>/trust.json`. Not now lasts this session, and Casper asks again next time.

In a folder you haven't trusted:
- Casper's checks, page checks, services and smoke checks don't run, whatever its `.casper/project.yaml` says.
  `/verify` and `/services start` say so instead of running.
- Where no sandbox runs, the project's installs, builds, tests and scripts are not routine (decision 2): they ask like
  any other command. Git, gh's look-and-open commands, reads and file work in the project stay routine. Inside the
  sandbox nothing changes.

"trust this folder" and "stop trusting this folder" (`/trust`, `/trust off`) change the answer, idle or during a task,
with no model call. `/permissions`, the banner, `/status` and the receipt say which applies.

A saved answer covers:
- the folder itself;
- a folder below it with no repository of its own;
- a worktree of a trusted repository that the repository's `git worktree list` names (a `/branch` folder, a builder's
  copy).

A repository inside a trusted folder is its own project and asks for itself. Your home folder and the top of a drive
are never trusted and never asked about. A project Casper makes for you opens trusted. Once, every folder Casper kept
state for before this change was saved as trusted, so nothing you already used asks.

A run that can't ask (`-p`, `--json`, piped, `CI`) is trusted for that run and saves nothing, as Claude Code's `-p` is:
starting it there is your choice, and scripts and CI keep working. `--no-verify` still turns its checks off.

**Why:** Casper ran a cloned repository's test, lint and build commands, and let the AI run its scripts and installs
(`npm ci` runs `postinstall`), without a word. Where no sandbox runs (Windows, no bubblewrap, the sandbox off at
Casper's own start), they ran with your rights. Claude Code, Codex and Gemini CLI ask once per new folder. In an
untrusted folder they don't run the folder's own configuration or tools.

**Same as:** Claude Code's folder trust question; Codex's and Gemini CLI's trusted-folder settings.

**Guard rails:**

- Only you can trust a folder. The AI has no tool for it, a project file can't set it, and the plain words count only
  when typed as a whole short line, not when pasted.
- Not now, Enter and Esc save nothing.
- Home and the top of a drive are refused even by `/trust`, and even with a record in them.
- The ancestor rule stops at a repository of its own, so trusting `~/Projects` doesn't trust what you later clone into
  it.
- A folder whose `.git` only points at a trusted repository isn't one of its worktrees.
- An untrusted folder never runs a check, page check, service or smoke check from Casper, and with no sandbox it never
  runs one of its own installs, builds, tests or scripts without your yes.

**A finding:**

- A check, page check, service or smoke check runs in a folder you haven't trusted.
- With no sandbox, an untrusted folder's install, build, test or script runs without a box.
- Not now, Enter or Esc saves trust.
- Home or a drive becomes trusted.
- A repository cloned into a trusted folder is trusted without its own answer.
- A folder that isn't a listed worktree inherits a repository's trust.
- The AI or a project file can set trust.
