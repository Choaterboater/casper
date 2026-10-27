# 41. Browser checks last the conversation

Date: 2026-10-26. Status: accepted (the owner chose this fix from a real session).

## Decision

The AI's browser still closes at each task's end. Its checks go on: the next task's browser takes the newest 24, so
their ids replay there.

- An earlier task's check is in no later task's report or end-of-task replays until it runs in that task.
- Its first run in a later task is its baseline there, as a new check's recording is. An earlier task's failure never
  stands as a later task's before-edit result.
- Until it runs, it can't be withdrawn on its own, only for a replacement that ran in this task. Otherwise
  [decision 6](../0002-deliberate-choices.md)'s rules apply as they are.
- `/clear`, `/resume` and a session switch forget them.

## Why

In a real session, the AI recorded a check in one task and replayed its id in the next to see the page before its
edit. "Unknown browser check id" came back three times. Twice the AI lost its before-edit result: "The earlier check
ID isn't available in this session. I'm recording a new 1280-wide fit check. It runs after the CSS edit, so it has no
before-edit baseline."

## Guard rails

- No result crosses tasks: a receipt counts only the checks its task ran.
- The rule against swapping a check for an easier one holds. A replacement must have run in this task and passed,
  on the same page and viewport, and test at least as much (decision 6).
- A replay asks what any check asks: the same approvals, Browser clicks setting and cloud metadata question.

A finding: an earlier task's result on a later task's receipt; an earlier task's baseline standing as a later task's
proof; a carried check withdrawn without a replay or a replacement that ran in that task; or checks that survive
`/clear`, `/resume` or a session switch.
