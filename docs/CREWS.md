# Crews: builders in their own copy

**What this is:** for a big job with separate parts, the AI splits the work
itself. It starts builders, each in its own copy of the project (a Git
worktree), and their changes land in your folder when they end. `/crew` is the
manual way: you give one builder a job and decide what happens to its work.
**When you'd use it:** you don't have to do anything; ask for the job as usual.
Say "run a crew" or "split this up" to ask for builders, "by yourself" to keep
the AI from using them.

Status: v0.3 Crews, built, not released. The AI starts builders itself; `/crew`
shipped in v0.2.23. One fix round per part follows a review, and reviewers
show while they work; the receipt names parts nobody reviewed.

## The AI splits big jobs itself

This works the way Claude Code's agent tool and omp's task tool do: the main AI
decides when a job has independent parts, and starts a builder for each one
with its `delegate` tool. Nothing asks you first.

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
footer shows reviewers and builders while they work:
`│ 1 reviewer · 2 builders · $0.19`, and the Working box names them too. Casper
also says in a `[crew]` line when a reviewer starts ("A reviewer is checking
part 2 (3 files)") and when a builder starts fixing what it found. What each one spent
joins the task's total (and the receipt) when it ends, and counts toward the
spend pause while it works: at the pause their tool calls wait for the answer
too, and "Stop here" stops them, each copy kept.

**Not reviewed.** A part counts as reviewed only when its reviewer finished. If a
reviewer timed out, failed or was cut off, or none was started, the receipt says
so in one line: `• Not reviewed: part 2 (a.ts, b.ts; the reviewer timed out)`.
`/crew` lists those parts too. It is a note, not a failure: nothing is undone,
no check changes, and nothing waits on you.

**Not forced in.** A builder's change is not applied when a file it changed
was also changed in your folder after its copy started (by you, the AI, or
another builder), when you made a commit since, when it would write
`<secret hidden>` into a file, or when the builder was stopped or did not
finish. Then the copy is kept, the AI is told, and Casper says so in one line; `/crew` lists the copy to apply or throw away. A builder that changed
nothing leaves no copy.

**Steer it with words.** "run a crew", "use a crew", "do this as a crew",
"split this up", "use builders" or "do these in parallel" in a request adds one
line to that task asking the AI to split the work across builders. Words about
crews themselves ("the crew list", "run the crew tests") don't count.
"no helpers" or "by yourself" means no builders for that request.

**Turn it off.** `/settings` → Helpers that build → Turn them off (it writes
`delegate: { build: false }` in `~/.casper/config.yaml`). A project file may
turn builders off for itself, never back on for you. Read-only helpers
([DELEGATION.md](DELEGATION.md)) still work.

**When builders are not offered.** Outside a Git repository, in a `/branch`
copy instead of the project's main folder, or where no sandbox runs (Windows,
or the sandbox can't start), the AI is not offered builders; its tool says why
in a few words, and it does the job itself.

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
  it can't ask you anything.
- Its edits stay in the copy: an edit or write anywhere else is refused.
- Files you made private (`sandbox.denyRead`) stay private in the copy too.
- Its commands run in the same shell sandbox as yours, with the copy as the
  project. A write outside the copy, a host you have not allowed, or a command
  that would need your OK is not run. The builder reads why and goes on; the
  report lists it under "Not run". Nothing waits on you.
- It can't move your branches or make commits: Git's folder it shares with
  your folder is read-only to it.
- The sandbox has one network gate for the whole session, and it can't tell
  whose command reaches out. So while a builder's command runs, a host nobody
  allowed is refused for your own commands too, not asked; Casper says so in
  one line.
- With the sandbox off (`--no-sandbox` or `sandbox: off`) its commands run with
  your permissions, as the AI's own do.
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

When a builder uses up its turns or tool calls, it gets one last turn with no
tools to report what it did. Esc stops running builders; their copies are kept
for `/crew`.

## Not a Git repository?

Builders need Git: each one works in its own copy. Outside a Git repository the
AI does the job itself, and `/crew` says so in one line.
