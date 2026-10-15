# Crews: builders in their own copy

**What this is:** for a big job with separate parts, the AI splits the work
itself. It starts builders, each in its own copy of the project (a Git
worktree), and their changes land in your folder when they end. `/crew` is the
manual way: you give one builder a job and decide what happens to its work.
**When you'd use it:** you don't have to do anything; ask for the job as usual.
Say "run a crew" or "split this up" to ask for builders, "by yourself" to keep
the AI from using them.

Status: v0.3 Crews is complete. `/crew` shipped in v0.2.23 and the AI starts
builders itself since v0.2.24; one fix round per part follows a review (v0.2.25),
reviewers show while they work, and the receipt names parts nobody reviewed. Since
v0.2.35 the crew's full checks run on the combined result, and a crew can start from
any worktree of the project.

## Where crews start and land

Both `/crew` and the AI's builders work from any Git worktree of the project,
not just the main checkout. A `/branch` experiment copy can start one too.
They cannot start inside another crew's copy, so crews cannot nest. Each copy remembers its originating folder in local Git
config, outside tracked files. Its work lands only in that folder, never in
another checkout; this survives a restart. Apply checks and whole-file conflict
checks use that same folder. Dependencies and private-path rules come from it too.

`/crew` lists kept copies across the repository and shows the source when it is
not your current folder. If the source folder has gone or is no longer a worktree
of this repository, the copy stays listed with a plain reason. It cannot be
applied anywhere else; keep it to look at or throw it away. The main checkout's
apply messages and receipts are unchanged.

## The AI splits big jobs itself

This works the way Claude Code's agent tool and omp's task tool do: the main AI
decides when a job has substantial independent parts (several files each, in different areas),
and starts a builder for each one with its `delegate` tool. Small or coupled work stays with
one Casper, rather than paying for builders and reviewers for tiny parts. This is model guidance,
not a keyword complexity classifier or a hard file-count gate. Nothing asks you first.

1. Each builder gets its own copy of your folder as it is now: your unsaved
   and new files are in it, and so is what the AI and earlier builders changed
   in this task. It is on the branch `casper/crew-<id>-1`, under
   `~/.casper/worktrees/`. Your
   `node_modules`, `.venv` and `vendor` are linked in, not installed.
2. It works with your main model, in the same sandbox as the AI's own commands,
   only in its copy (see [What a builder can do](#what-a-builder-can-do)).
3. When it ends, its change is applied to your folder, uncommitted, with no
   question. Each file it changed counts as the AI's own edit: checks, dev
   servers, the receipt and `/undo` treat it the same way, so one `/undo` takes
   the whole task back, builders' work included.
4. The main AI gets back what changed (files and a short report), what was not
   run and why, and what it cost, with a reminder to have a read-only reviewer
   look at a landed part (skipped for a few-line part). Each landed part has a
   number in that result. A reviewer started with that number (`of`) is given
   the part's job, files and diff by Casper, so the AI does not have to pass
   the diff along. The diff is cut at 24 KiB, with a note, and binary files are
   named only. Such a reviewer is read-only like any other, its cost joins the
   task's total, and it does not use up the 4 helpers a task allows: each part
   gets one review. A part that was kept in its copy, or failed, has no
   number. It does the rest itself. A builder started with that number (`of`)
   fixes the part: it is handed the reviewer's report (cut at 8 KiB) and told
   to fix only those findings, check each is real, and not widen the change.
   That works without a review too. Each part gets one fix round; a second is
   turned away and the AI fixes the rest itself. The fix starts from your
   folder with the part in it, lands the same way, and one `/undo` takes both
   back. A part gets one review before its fix and one after; the second sees
   the fix's own diff and stat. A file the fix touched that the part did not
   is named in the result. When the last builder ends, its result also lists
the landed parts no reviewer has finished yet: a nudge, never a gate.

Up to 3 builders work at once, and 6 per request, besides fix builders: those
have their own count, and first builds and fixes together stop at 9. The
live row under the AI's words names reviewers and builders while they work. The footer keeps one task state and one task cost figure. Casper
also says in a `[crew]` line when a reviewer starts ("A reviewer is checking
part 2 (3 files)") and when a builder starts fixing what it found. What each one spent
joins the task's total (and the receipt) when it ends, and counts toward the
spend pause while it works: at the pause their tool calls wait for the answer
too, and "Stop here" stops them, each copy kept.

**Not reviewed.** A part counts as reviewed only when its reviewer finished. If a
reviewer timed out, failed or was cut off, or none was started, the receipt says
so in one line: `– Not reviewed: part 2 (a.ts, b.ts; the reviewer timed out)`.
`/crew` lists those parts too. It is a note, not a failure: nothing is undone,
no check changes, and nothing waits on you.

**Full checks on the combined result.** In verification `auto` mode, after the
reviewers, fix round and any later repairs, Casper runs the project's full selected
checks before the crew's receipt. These are `verification.checks`, or all configured
and detected automatic checks when no selection is set (typecheck, lint, test,
build, and automatic named checks). Nothing is pruned for file scope or prose-only
changes. Earlier per-part passes do not replace this run. A whole batch already
run after the crew counts once if the combined files and reviews have not changed;
otherwise Casper runs a fresh batch on the final result. Builder, reviewer and
one-fix-round limits are unchanged.

The receipt says `– Crew full checks on the combined result: pass (typecheck, lint,
test, build)` or shows failure/incompleteness. A failure found by the final sweep
is reported, not given another crew fix round. Timeouts, checks that cannot start,
skips and sandbox refusals are not passes. `offer`, `off` and stopped tasks start
no final sweep; the receipt says why it did not run. With no checks configured it
says incomplete. The project selection and manual-only checks still apply, and
no device check starts automatically, even if explicitly selected. `/crew`'s
manual copy/apply flow is unchanged; this sweep is for parts automatically landed
in your folder.

**Not forced in.** A builder's change is not applied when a file it changed
was also changed in your folder after its copy started (by you, the AI, or
another builder), when you made a commit since, when it would write
`<secret hidden>` into a file, or when the builder was stopped or did not
finish. Then the copy is kept, the AI is told, and Casper says so in one line; `/crew` lists the copy to apply or throw away. A builder that changed
nothing leaves no copy.

**Steer it with words.** "run a crew", "use a crew", "do this as a crew",
"split this up", "use builders" or "do these in parallel" in a request adds one
line to that task asking the AI to split only substantial independent parts across builders;
small or coupled work still stays with one Casper. Words about
crews themselves ("the crew list", "run the crew tests") don't count.
"no helpers" or "by yourself" means no builders for that request.

**Turn it off.** `/settings` → Helpers that build (Enter or Space flips it; it writes
`delegate: { build: false }` in `~/.casper/config.yaml`). A project file may
turn builders off for itself, never back on for you. Read-only helpers
([DELEGATION.md](DELEGATION.md)) still work.

**When builders are not offered.** Outside a Git repository, without a first
commit, or inside another crew's copy, the AI is not offered builders; its
tool says why in a few words, and it does the job itself. Builders run with the
sandbox off too (the default): their commands ask in your box, as below.

## /crew: the manual way

```text
/crew Add a --quiet flag to the build script and test it
/crew                 copies still here, with 1 Leave them · 2 Apply 1 · 3 Throw away 1 ...
/crew apply 1         apply copy 1 to your folder, without the question
/crew drop 1          throw copy 1 away, without the question
```

One builder does your job in its own copy, as above. Your folder stays as it is
until you pick. When it ends, Casper shows what it did, what it cost, the files
it changed and anything it could not run. Then one question:

```text
What should happen to the crew's work?
  1 Keep the copy        look first: <path>; /crew applies it later
  2 Apply to my folder   uncommitted; your own changes stay
  3 Throw it away        the files are kept in Casper's recovery folder
```

Enter picks 1. Where Casper can't ask (one-shot, `--json`, a pipe), the copy is
kept; `/crew` lists it. **Apply** goes by lines: your own unsaved changes stay,
and nothing is applied when the copy's lines clash with yours, or you made a
commit since. `/undo` does not cover `/crew apply`.

## What a builder can do

- The built-in tools: `read`, `edit`, `write`, `bash`, `grep`, `find`, `ls`.
- No MCP tools (so no network changes), no `delegate`, no crew of its own, and
  it can't ask you questions of its own.
- Its edits stay in the copy: an edit or write anywhere else is refused.
- Files you made private (`sandbox.denyRead`) stay private in the copy too.
- Its commands run in the same shell sandbox as yours, with the copy as the
  project. A command that needs your OK (one that changes things with the
  sandbox off, another machine to reach) asks in your box, named for the
  builder: `Builder 2 wants to run: npm install`. Your remembered answers and
  `/permissions all` count for it as for the AI's own commands. A write outside
  the copy or a host you have not allowed is not run. Where Casper can't ask
  (one-shot, `--json`, a pipe) nothing is asked: the builder reads why and goes
  on, and the report lists it under "Not run".
- It can't move your branches or make commits: Git's folder it shares with
  your folder is read-only to it.
- The sandbox has one network gate for the whole session, and it can't tell
  whose command reaches out. So while a builder's command runs, a host nobody
  allowed is refused for your own commands too, not asked; Casper says so in
  one line. After `/permissions all` such a host is allowed for the session.
- With the sandbox off (the default, `--no-sandbox` or `sandbox: off`) its
  commands run with your permissions, as the AI's own do.
- Secret files such as `.env` are not in the copy (Git does not track them).
  A test that needs one fails there; the report says so.

## Limits

| Limit | Value |
| --- | --- |
| Builders running at once | 3 (read-only helpers have their own 2) |
| Builders the AI starts per request | 6 |
| Time per builder | 20 minutes |
| Model turns per builder | 60 |
| Tool calls per builder | 240 |
| Job / context size | 16 KiB / 32 KiB |
| Report size | 16 KiB |
| Size of one builder's change | 512 KiB and 200 files, like experiments |

When a builder uses up its turns or tool calls, or is 30 seconds from its time
limit, it gets one last turn with no tools to report what it did, marked
partial, if the step it is on finishes in time. Otherwise it is stopped at the
limit and the main AI still gets its last words or where it looked. Esc stops
running builders; their copies are kept for `/crew`.

## Not a Git repository?

Builders need Git: each one works in its own copy. Outside a Git repository the
AI does the job itself, and `/crew` says so in one line.
