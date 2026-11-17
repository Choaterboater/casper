# 115. A /branch experiment links the main folder's dependency folders

Date: 2026-11-17. Status: proposed. A `/branch` experiment is a fresh Git worktree, and Git does not track installed
dependencies: in a JS or Python project its tests and dev server failed, and `/switch main apply`, which runs the
checks in the worktree before it captures the diff, could refuse with `Candidate verification failed`. Crew copies
already link the main folder's `node_modules`, `.venv` and `vendor` (`src/crew/copies.ts`). T3 Code runs a setup step
in each new worktree by default; this is Casper's no-cost form of it, the one its crews use.

## Decision

- **Linked, not installed.** After the worktree is made, each of `node_modules`, `.venv` and `vendor` that the main
  folder has as a real folder and the worktree lacks (a tracked `vendor/` is already there) becomes a link to the
  main folder's (a junction on Windows). No install runs, no network, no tokens. Casper prints what it linked; the
  branch preview lists the candidates.
- **Out before the diff.** The links stay for the checks `apply` runs, then come out before the patch is captured,
  for `apply` and `discard` alike: Git does not match a link against `node_modules/`, so one left in place would be an
  untracked file in the patch (or, against `node_modules`, an ignored file the return refuses). Removal therefore
  never sees them either, and a branch that fails to start takes them out before its worktree is removed. Taking a
  link out deletes the link only, never what it points to, and only a link that points at the main folder's folder
  comes out: a link the repository tracks (`vendor -> third`) stays, so the patch never deletes it.
- **Back when the branch goes on.** A return that is not approved, cannot capture its diff or cannot switch the
  conversation to main, and a later `/switch`
  to the branch (after an `apply` that stopped, say), put the links back.
- **Shared, and said so.** Crews rely on the sandbox to keep the linked folders read-only. A `/branch` session runs
  with the sandbox off by default, so an install or `rm -rf node_modules/` there writes through to the main folder.
  Casper does not block or detect install commands (no box Claude Code lacks). Instead the branch's AI is told, in that
  branch's fork notes only (never the fixed prompt), which folders are linked, that an install or delete in them
  changes the main folder's, and to remove just the link (`rm node_modules`, no trailing slash) before installing.
  SECURITY.md lists this under what is not held back.
- **No switch.** As for crews: a link you do not want is removed with one `rm` in the branch.

## Trade-off

A branch that needs different dependencies has to replace the link with a real folder; that folder is ignored by Git,
so the return refuses until it is removed, as it did before for any install in a branch. Copying or installing per
branch would avoid sharing, at the cost of time, disk and (for installs) network on every `/branch`.

## Guard rails

- `tests/session-branch-dependencies.test.ts`: a branch links both folders and its fork notes say they are shared;
  `apply` checks with the links in place and applies a patch without them, and `discard` drops the experiment, for
  both `node_modules/` and `node_modules` ignore lines, leaving the main folder's dependencies whole and its status
  clean; a declined return, and one that stops after the yes, put the links back; a main folder with none links nothing and adds no note;
  a branch whose fork fails leaves no worktree and the main folder's dependencies whole; a tracked `vendor` link stays
  through a declined return and an `apply`, and is not in the patch.

## A finding

A link in a captured patch or in the recovery folder; a return or cleanup that deletes what a link points to, or a
link the repository tracks; the note in the system prompt or the fixed prompt; a block or question added before an
install in a branch.
