# 61. The judge's allow is quiet, and waits and local GETs never reach it

Date: 2026-11-02. Status: accepted (merged 2026-11-02 in #576). Amends [47](47-auto-mode-judge.md) (auto mode: a model judge for commands that would ask).

## Decision

- **No line for an allow.** When the judge allows a command, it runs with no line on the screen (47 printed
  `✓ judge: <why>`). The reason is kept: the step's Ctrl+T view starts with it, and `/status` has a `judge` row with how
  many commands it allowed this session and the last one with its reason. An ask is unchanged: the usual box, with
  `The judge says: <why>`.
- **Waits and looks at your own app skip it.** `sleep N` (alone, or before a read: `sleep 120; tail -n 20 x`) and a
  plain GET from this computer's own server (`curl -s http://localhost:5000/`, with `-o /dev/null -w …`) are routine
  work, so no judge call is made and no box shows. A POST, an output file, another host or a `sleep` with an option
  still go to the judge.

## Guard rail

The judge is still asked about everything else it was asked about before, and never refuses (it allows or asks).
Whatever it allowed stays findable: Ctrl+T on the step, and `/status`.

**Why:** the owner's sessions showed `✓ judge: sleep 90 just waits locally for 90 seconds; harmless…` between every
poll, and a line per allowed dev-server start. "Read-only or routine commands skip the judge, and an allow from the
judge shows no line unless the person asks."
