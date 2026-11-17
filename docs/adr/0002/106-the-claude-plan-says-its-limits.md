# 106. The Claude plan says its limits, and a used-up one switches at once

Date: 2026-11-16. Status: proposed. Extends 38 (failover) and 54 (one live Claude Code session). Under 54, Casper
read only Claude Code's start, its errors, its result and the streamed answer, and dropped everything else. One of
the dropped messages was `rate_limit_event`: Claude Code sends it whenever a plan window's share, reset or status
moves (the 5-hour limit, the weekly limits, extra usage). So Casper never knew how much of the plan was used. When
the 5-hour limit ran out, the error read as a passing rate limit ("wait a minute, then ask again"), or as nothing
Casper could name, and failover treated it as a limit that lifts by waiting, so the engine's own tries on the same
model came first. The idea of reading these events comes from another coding-agent app (T3 Code) that shows the
plan's windows the same way.

## Decision

- **Kept, not asked for.** The subscription runtime keeps the latest event per window
  (`src/runtime/plan-limits.ts`), for every conversation and helper in this Casper: the Claude account is one. No
  request is added and no tokens are spent. `RuntimeSession.planLimits()` gives the windows (window, status, reset,
  share, extra usage, used up), the one that matters most first.
- **One line in `/usage` and `/status`.** `Claude plan: 82% of 5-hour limit, resets 3:40 PM`; only once Claude Code
  has reported a window. A window over its limit while extra usage pays for requests reads `5-hour limit reached,
  using extra usage`: requests still go through, so it never reads as refused.
- **One notice.** When a window turns to Claude Code's warning, or requests start using extra usage, the main
  conversation says it once per window and reset, after the response that carried it.
- **The error names the window.** A refusal (`rate_limit`) while a window is used up, with no extra usage and its
  reset still ahead, gets `Claude plan limit reached: five_hour until <time>.` added to Claude Code's own words. From
  that, the error line is `Your Claude plan's 5-hour limit is used up; it resets at 3:40 PM. Next: wait until then,
  or /model to pick another model.`, and the receipt's next step waits for that reset. Every other rate limit keeps
  "wait a minute".
- **Failover switches at once.** That error is a usage limit (cause `quota`), not a passing one: Pi doesn't try it
  again before the reset, and with a failover list the task switches at once to the first model you listed. Your
  requests then stay on that model until the window resets, as the switch line says (`Your requests stay on
  provider/model-b until the Claude plan's 5-hour limit resets at 3:40 PM, then go back to …`). The first task after
  the reset starts on your model again. Your model isn't tried while the hold lasts, and `/status` and the footer
  name the model in use meanwhile.

## Why

A used-up 5-hour window is refused for hours. Trying it again a minute later, or several times with backoff, only
delays the switch, and telling the person to wait a minute is wrong. Going back to the Claude model after every task
would fail each next task's first request the same way. Claude Code already sends the windows with every response,
so knowing them costs nothing.

## Guard rails

- Only models you listed: the hold keeps the model failover picked under decision 38's rules, and nothing new is
  picked. Without a list, the task stops at the limit as before, with the window and reset named.
- Nothing is saved: the windows live in memory for this Casper, and a hold ends at the reset, or when Casper ends.
  Your default and the conversation's model don't change.
- Extra usage in use is never treated as used up, and a window with no known reset doesn't hold anything.
- A key, refusal or request error stays what it is, even with a window used up.
- No extra call: nothing asks Claude Code or Anthropic for usage.

`tests/plan-limits.test.ts` checks the windows from faked Claude Code messages, the `/usage` line, the error and
receipt words, Pi's retry, and failover's switch and hold. Through Pi's runtime,
`tests/scripting-failover.integration.test.ts` checks that tasks stay on the model switched to until the reset and
the first one after it starts on yours, and `tests/claude-subscription-runtime.test.ts` that a warning is said once in
the main conversation and never in a side request.
