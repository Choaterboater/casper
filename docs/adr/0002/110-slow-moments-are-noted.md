# 110. Slow moments are noted on this computer, and /doctor counts them

Date: 2026-11-17. Status: proposed.

When Casper's screen froze for a few seconds (a big output folded, a long file parsed, a sync call that should not
have been), nothing recorded it: there was no event-loop or memory measurement anywhere in `src`, so a report of
"it hung for a moment" could not be checked afterwards. T3 Code ships an event-loop monitor that logs each stall of
2 s or more to a capped file (`STALL_THRESHOLD_MS = 2e3`, `STALL_LOG_MAX_BYTES = 262144`); this follows that.

## Decision

- **One drift timer.** `src/platform/slow-moments.ts` runs one unref'd 250 ms `setInterval` and compares each tick
  with a monotonic clock (`performance.now()`). A tick 2 s or more late means the event loop was stuck that long.
  Lateness is measured from the tick that was due, so a moment's length is up to one tick (a quarter second) short,
  and a stuck loop of 2 to 2.25 s may be missed; a 1 s tick would have missed up to 3 s and been a second short.
  Bun 1.4 has `perf_hooks.monitorEventLoopDelay`, but it gives a histogram, not each moment with its length and time;
  the timer needs nothing from the runtime and works the same in a compiled binary.
- **One JSON line per moment** in `~/.casper/run/slow.log`: `{time, ms, rss, activity}`. The file is `0600` in
  Casper's `0700` run folder (on the private-places list). `activity` is what ran, from the work view Casper already
  keeps: the kind of step and its tool (`running a command`, `reading files (grep)`, `running checks`,
  `the model replied`, else `a task ran`), never a command, path or output. Idle at the prompt, it is left out.
- **Capped at 256 KB.** Past that the older half is dropped (whole lines kept), through a temporary file and a rename.
- **Interactive sessions only.** The `casper` command's interactive session starts it after sign-in and stops it when
  Casper closes (the lifecycle registry). `casper -p`, `casper acp` and app tests that run a session note nothing.
- **/doctor adds one line**: `Slow moments: none in the last day`, or `Slow moments: 3 in the last day (longest
  6.1 s, while running a command)` as worth knowing (`!`), with the log's place. Never a failure.
- **On by default, with an off switch.** `/settings` **Slow moments** (Display) writes `slow_moments: false`; it
  applies from that moment, as the timer reads the setting at each slow moment. A project file can't set it. It
  costs no tokens and nothing is sent.

## Guard rails

- A tick a minute or more late is a computer that slept or a Casper paused from outside, not a stuck loop, and is
  not noted: a loop stuck a whole minute is far rarer than either. Where the monotonic clock stops while the
  computer sleeps (macOS, Linux) a sleep shows as no lateness at all; where it runs on (Windows), a sleep shorter
  than a minute is noted as a slow moment. That is accepted: JavaScript has no clock that stops in sleep there, and
  `/doctor` only reports the count as worth knowing.
- Writing the log never throws into the session: a moment that can't be written is skipped.
- Several Caspers append to the same file (one short append each); two trimming at once may lose a few old lines,
  which is accepted for a diagnostic log.
- Nothing is removed but the log's own older half; the file is Casper's record, not yours.
- `tests/slow-moments.test.ts` drives the timer and both clocks by hand (no real waits): a tick on time notes nothing,
  a late one is one line with its memory and activity (`0600` in `0700`), off and a slept computer note nothing, the
  log drops its older half past its size, `/doctor` counts only the last day's and names the longest, and the activity
  never carries a command's text. The same file runs the session's own watch on a stand-in app: what ran comes from
  the work view (`a task ran` when it has no word), nothing is noted when slow moments are off, it writes under the
  session's home, and Casper closing stops it. `tests/settings-switches.test.ts` checks the row and that a project can't set it.
