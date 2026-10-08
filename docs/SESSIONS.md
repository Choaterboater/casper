# Named Sessions and Worktree Experiments

**What this is:** a way to branch a conversation under a name, and, in a Git
project, to try the change in a separate copy of the repo (a Git *worktree*).
**When you'd use it:** to try a risky idea without touching your main folder,
then either apply the result or throw it away after you look at the diff.

## Who owns what

- **Pi owns the conversation.** Casper uses Pi SDK 0.87.0 to copy and resume
  Pi's saved conversation files (JSONL). Casper keeps no second copy of the
  messages.
- **Casper owns the names.** A small file,
  `~/.casper/sessions/<project-key>.json`, maps each branch name to its Pi
  conversation file and, if there is one, its Git worktree.
- **Git owns the code.** An experiment uses the Git branch `casper/<name>`, in a
  worktree under `~/.casper/worktrees/<project-key>/`.

## Commands

Interactive commands:

```text
/tree                   show main and every named branch
/branch <name>          start a named branch from main
/switch <branch>        move to that branch (conversation and folder)
/switch main apply      check, review and apply the experiment to main
/switch main discard    review, then drop the experiment
```

- `/tree` is local. It does not start the model.
- A branch name is 1–64 letters, digits, dots, underscores or hyphens. `main` is
  reserved.
- You can only create a branch while you are on `main`.

### `/branch <name>`

Copies the current conversation and records the project context. If the policy
says to isolate experiments (the default) and the project is a Git repo, it also
creates a clean worktree from the main folder's current commit.

You typed the command, so Casper doesn't ask again: it makes the branch and says
where it is. In one-shot mode (`casper "<prompt>"`) it refuses, because there is no one to
answer.

### `/switch <branch>`

Resumes that branch's conversation and moves Casper to its folder, with no second
question (you typed the command). Before it moves, Casper disconnects MCP and language-server connections
and removes their tools. It then reads the project context of the new folder,
and you have to approve connections again. If Casper cannot load the new
folder's settings, it blocks further commands until it can.

When you start Casper in the main folder, it starts on `main`. When you start it
inside an experiment's worktree folder, it resumes that branch's saved
conversation. A Git worktree you made yourself (`git worktree add`) is a folder
of its own: it starts on its own `main`, and its saved conversation is kept
apart from the main folder's. Isolated experiments still start from the main
folder.

A one-shot run (`casper "<prompt>"`, `casper --json ...`) starts a new conversation
unless you give it `--continue` or `--resume`, even in a folder where a session left one
open. Its `/clear` or `/resume` lasts for that run only and says so: it does not change
what the next session opens.

From the command line, `casper --continue` continues the folder's most recent
conversation, and `casper --resume <id-prefix>` continues the saved one whose ID
starts with that text (see [SCRIPTING.md](SCRIPTING.md)). When they open an
interactive session, they change the conversation of the named session you are on,
the same way `/resume` does.

### Coming back to main from an experiment

An experiment in its own worktree cannot use plain `/switch main`. Pick one:

- **`apply`**: Casper runs the configured checks in the experiment folder, then
  captures the full diff. It shows the files, a size summary, the content and a
  SHA-256 fingerprint of the patch, then asks `1 No · 2 Yes, this once`. Casper applies that exact
  patch to main **without committing**, then cleans up the worktree and branch.
- **`discard`**: Casper captures and shows the full diff, then asks `1 No · 2 Yes, this once`. Casper
  cleans up the worktree and branch and does not apply anything.

If a check fails or is blocked, `apply` stops before asking you. Checks that are
not configured show as `incomplete`, and you still have to approve. If files
change after you approve, the experiment stays open.

If the experiment's worktree was deleted, or its branch changed (for example a
detached HEAD), Casper cannot capture a reviewed diff, so `apply` and `discard`
refuse. Plain `/switch main` is then allowed. It only
switches the conversation and deletes nothing. `/tree` marks the experiment
`cleanup pending` so you can check its worktree and `casper/<name>` branch by
hand.

### What "clean up" means

Cleanup **unregisters** the Git worktree and branch, but keeps the files. They
are moved (renamed in one step) to:

```text
~/.casper/worktrees/recovery/<project-key>/<worktree-name>-<random-id>/
```

Casper prints this path and shows it in `/tree`. It is a normal folder, not a
Git worktree you can resume; its `.git` pointer no longer works. It also keeps
files written after the last snapshot, including ignored files. Casper never
deletes recovery folders. Remove them yourself when you no longer need them.
"Discard" means "do not apply", not "wipe from disk".

## Policy

Defaults:

```yaml
workspace:
  isolateWhen:
    parallelAgents: true
    riskyRefactor: true
    experimentalBranch: true
```

Settings are read in this order, later wins: built-in defaults, then
`~/.casper/config.yaml`, then the profile's `config.yaml`, then the project's
`.casper/project.yaml`.

Only `experimentalBranch` changes what Casper does today, in `/branch`.
`parallelAgents` and `riskyRefactor` are shown to the model as project policy,
but no Casper feature acts on them yet. With
`experimentalBranch: false`, `/branch` still makes a named conversation branch,
but it shares the main folder (no worktree).

Casper does not create worktrees for normal edits. It creates one only when you
run `/branch` and the policy says to isolate.

## Safety and limits

- The main folder must be clean (no uncommitted changes) when you plan the
  branch and when it is created. Its commit must not change while you approve.
  Two `/branch` calls with the same name are handled one at a time; the loser
  cannot remove the winner's worktree.
- Casper only acts on worktree paths and `casper/*` branches it created. It
  checks the repo, the worktree registration, the base commit, a clean main
  folder and the experiment's identity again before each step that changes
  something.
- The diff covers tracked, deleted, executable-bit, binary and untracked files.
  Casper builds it with a temporary Git index; your repo's index is not changed.
- Ignored files in the experiment cannot go into the patch. If there are any,
  apply refuses and keeps the worktree until you save or remove them by hand.
  Ignored files already in main are left alone.
- A patch can be at most **512 KiB** and **200 changed files**. A bigger
  experiment stays in place for you to review and apply by hand.
- Terminal control characters in the preview are escaped. The SHA-256 is of the
  original patch bytes.
- After apply, main's diff must match the reviewed patch's SHA-256. If the
  experiment changes while you approve, it is not removed.
- If the main folder is dirty or its commit moved, apply refuses. Both folders
  are kept for you to sort out.
- **Casper never commits or pushes an applied patch.** The `git.commit` and
  `git.push` policy (`neverUnlessRequested` by default) and "ask before
  destructive operations" are instructions to the model, not blocks. The
  model's bash tool can still run `git commit`, `git push` or `rm`.
- The one block: the model's bash tool may not run `git stash` (except `list`
  and `show`), `git reset --hard` (also `--merge` and `--keep`), `git checkout`
  with `--`, `.`, `-f` or `-p`, `git restore` of the working tree,
  `git switch -f` or `--discard-changes`, or `git clean` (except `-n`). Each of
  these can set aside or throw away your uncommitted work. This is a check of
  the command text, not a sandbox; a script or alias can get past it.
- Approval for applying or discarding an experiment lasts only for this Casper
  process. Files in the project cannot answer an approval prompt.
- A worktree keeps file changes apart; it is not a security boundary. Since
  v0.2.17 the shell sandbox holds shell commands to the folder you are in, and
  the model's file tools stay out of private places (see
  [SECURITY.md](SECURITY.md)).

State files use mode `0600` and are replaced in one step. If the names file is
damaged, Casper stops with an error rather than reset it.

POSIX file modes are not Windows ACLs; see [platform support](PLATFORM_SUPPORT.md).
