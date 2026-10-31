# 26. A line you send ends a step that only waits

Date: 2026-10-23. Status: accepted (merged 2026-10-23 in #477).

## Decision

Pi reads a line steered in during a task only once every tool call of the AI's step has ended. A step that only
waited held the line up: a browser sign-in window for up to 10 minutes, a slow shell command for up to 2, a service
start for its readiness time. Pressing Esc to get the AI's attention then stopped the whole task. Now a line that
reaches the AI ends such a wait, so the AI reads it now:

- the sign-in window closes as if the person had closed it, and the AI is told `person wrote`;
- a slow shell command moves to the background, as it would at its 2-minute limit, and keeps running;
- a service start or restart stops waiting for readiness, says `starting` and keeps starting.

Others do the same: Copilot CLI's steering interrupts shell output waits without stopping the command, Claude Code's
"send now" moves running work to the background and reads the message in the same turn, and in oh-my-pi a queued
steering message ends a service's readiness wait while the service keeps starting.

## Guard rails

- Only a line that reaches the AI ends a wait, and only the waits listening when it comes. A queued line (Casper runs
  checks or writes the receipt) ends none.
- Nothing is stopped. Closing the window the graceful way keeps a sign-in finished there. The command keeps its
  process tree, sandbox and log, and gets the note it gets at the limit. The service keeps its start. Once moved this
  way, Esc no longer stops them, as it doesn't stop a slow command in the background: `/tasks`, the service tool and
  `/services stop` do, and closing Casper stops them all.
- A command with its own time limit, one on Casper's ssh login (it may still ask for a password) and one with 4
  already in the background run on, and the line waits as before. MCP calls, helpers and checks are not ended: their
  results have no later way back to the AI.

A finding: a line that stops work instead of ending a wait, a queued line ending one, or a wait ended with no line.
