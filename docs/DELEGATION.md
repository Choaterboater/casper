# Read-only explorer and reviewer agents

**What this is:** a small helper agent that only reads your files. An *explorer*
finds where things are. A *reviewer* looks for problems in code you point it at.
**When you'd use it:** to get a second look, or to search a big project, without
letting anything change your files.

## Commands

```text
/delegate explorer Find the authentication entry points and their callers
/delegate reviewer Inspect src/sessions/manager.ts for approval-race risks
```

The main model can also start a helper itself, with the `delegate` tool. It
passes a `role` (`explorer` or `reviewer`), a `goal`, and optional `context`.
Both ways make a model request, so they use your provider account.

The same tool has a third role, `builder`: a helper that edits and runs
commands in its own copy of the project, whose change lands in your folder when
it ends. The AI uses it for a big job with separate parts. See
[CREWS.md](CREWS.md); everything below is about the read-only roles.

## What a helper can do

- It gets only four tools: `read`, `grep`, `find` and `ls`.
- No shell, no edits, no MCP or language-server tools, and it cannot start
  another helper.
- It starts fresh. It does not see your conversation, only the goal and context.
- It reads the folder you are working in, including changes you have not
  committed. It does not make a worktree (a separate copy of the repo).
- If you switch workspace, Casper waits for running helpers to finish first.

For a helper that edits and runs commands in its own copy of the project, see
[CREWS.md](CREWS.md) (builders, and `/crew`).

"Read-only" here means Casper gives the helper only read tools. It is **not an
operating-system sandbox** and not a spending cap. A helper's report is advice,
not proof that the code works.

## Limits

| Limit | Value |
| --- | --- |
| Helpers running at once | 2 |
| Helpers per request you send | 4 |
| Time per helper | 180 seconds |
| Model turns per helper | 12 |
| Tool calls per helper | 48 |
| Goal / context size | 4 KiB / 8 KiB |
| Report size returned to the main model | 16 KiB |

- A third helper turned away because two are already running does not count
  toward the 4. It can be sent again later.
- When a helper uses up its turns or tool calls, it gets one last turn with no
  tools, so it can report what it found so far.
- A helper stopped part way returns its last words, not an empty report. Its
  status says it was cut short.

## Which model a helper uses

- Explorers use Casper's `fast` model role. Reviewers use the `review` role.
  Set roles with `/model role` (see [CONFIGURATION.md](CONFIGURATION.md)).
- If a role is not set, the helper uses your saved Casper startup default. It
  does not use the parent's temporary `/model --session` choice, or Pi's own
  defaults.
- If a role is set but that model is not usable, the helper fails. It does not
  quietly pick another provider.
- Effort suffixes on a role (for example `:high`) and automatic effort apply to
  the helper only. Nothing is saved, and no helper transcript is kept.

## Errors and how they are reported

- **Short provider errors** (for example a 429 rate limit, "Provider returned
  error", or a dropped connection) are retried the same way as in the main
  session: up to 3 retries, after 2, 4 and 8 seconds, inside the 180-second
  limit. Cancelling stops the wait. A helper that recovers reports `completed`.
- **Output cut off by the model's token limit** while it was calling tools is
  not the end: those calls are not run, the helper is told why, and it sends
  them again. Only a final reply that is cut off makes the status `limited`.
- **Large files** are not an error. `read` returns the first 2000 lines or
  50 KB with a note such as
  `[Showing lines 1-1275 of 3400 (50.0KB limit). Use offset=1276 to continue.]`,
  and the helper carries on from there.
- **A tool that fails** is reported with its first error line, as the helper saw
  it, for example `read: EISDIR: illegal operation on a directory, read` or
  `read: ENOENT: …`. You do not just get "tool failed".
- Status is one of `completed`, `failed`, `cancelled`, `timed_out` or `limited`.
  `/delegate` shows the report, then fails the command if the status is not
  `completed`.

Helpers read no `settings.json`, so this retry policy cannot be changed for them.
