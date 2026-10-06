# Crews: a builder in its own copy

**What this is:** you give Casper a job with `/crew`, and a builder AI does it
in its own copy of the project (a Git worktree). Your folder stays as it is
until you say so.
**When you'd use it:** to try a change without touching your files, or to
look at the result before it lands.

Status: the first part of v0.3 Crews, built, not released. Today a crew has one
builder. Splitting a big job into parts, a reviewer per part, merging the parts,
the status bar and `/undo` over a crew come next.

## Commands

```text
/crew Add a --quiet flag to the build script and test it
/crew                 copies still here, with 1 Leave them · 2 Apply 1 · 3 Throw away 1 ...
/crew apply 1         apply copy 1 to your folder, without the question
/crew drop 1          throw copy 1 away, without the question
```

Only you start a crew. The AI never starts one by itself: a crew makes model
requests, and Casper spends no tokens unless you ask.

## What happens

1. Casper makes a copy of the project from your last commit, on the branch
   `casper/crew-<id>-1`, under `~/.casper/worktrees/`. Changes you have not
   committed stay in your folder and are not in the copy.
2. Your `node_modules`, `.venv` and `vendor` folders are linked into the copy,
   not installed again. The builder is told not to install anything; if it needs
   a new dependency, it says so.
3. The builder works with your main model. It may read, edit and run commands,
   only in the copy.
4. When it ends, Casper shows what it did, what it cost, the files it changed,
   and anything it could not run. Then one question:

   ```text
   What should happen to the crew's work?
     1 Keep the copy        look first: <path>; /crew applies it later
     2 Apply to my folder   uncommitted; your own changes stay
     3 Throw it away        the files are kept in Casper's recovery folder
   ```

   Enter picks 1. Where Casper can't ask (one-shot, `--json`, a pipe), the copy
   is kept; `/crew` lists it.

**Apply** puts the change in your folder, uncommitted; `git diff` shows it.
Nothing is applied when you made a commit since the crew started, or when a file
the crew changed was also changed in your folder. Then the work stays in the
copy. `/undo` does not cover a crew yet.

A builder that changed nothing leaves no copy. A copy left behind by a crash
shows up in `/crew`.

## What a builder can do

- The built-in tools: `read`, `edit`, `write`, `bash`, `grep`, `find`, `ls`.
- No MCP tools (so no network changes), no `delegate`, no crew of its own, and
  it can't ask you anything.
- Its edits stay in the copy: an edit or write anywhere else is refused.
- Its commands run in the same shell sandbox as yours, with the copy as the
  project. A write outside the copy, a host you have not allowed for this
  project, or a command that would need your OK is not run. The builder reads
  why and goes on; the crew's report lists it under "Not run (it needed your
  OK)". This matches background helpers in other tools: nothing waits on you.
- Where no sandbox can run (Windows, `--no-sandbox` or `sandbox: off`), the
  rules are the main session's: on Windows the builder's commands need your OK,
  so they are not run; with the sandbox off they run with your permissions.
- Secret files such as `.env` are not in the copy (Git does not track them).
  A test that needs one fails there; the report says so.

## Limits

| Limit | Value |
| --- | --- |
| Builders running at once | 3 (helpers from `/delegate` have their own 2) |
| Time per builder | 20 minutes |
| Model turns per builder | 60 |
| Tool calls per builder | 240 |
| Job / context size | 16 KiB / 32 KiB |
| Report size | 16 KiB |
| Size of a crew's change | 512 KiB and 200 files, like experiments |

When a builder uses up its turns or tool calls, it gets one last turn with no
tools to report what it did. Esc stops a running builder; its copy is kept for
`/crew`.

## Not a Git repository?

A crew needs Git: each builder works in its own copy. Outside a Git repository
`/crew` says so in one line; ask for the job as usual and Casper does it as one
task.
