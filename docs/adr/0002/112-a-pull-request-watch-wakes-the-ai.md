# 112. A pull request watch wakes the AI

Date: 2026-11-17. Status: proposed. Extends the `github` tool ([GITHUB.md](../../GITHUB.md)). Until now nothing in
Casper started a model turn by itself: a background job that ends adds a note and offers a Next row that only your key
sends. Watching a pull request for CI and reviews meant asking again and again. T3 Code sweeps watched pull requests
every 2 minutes, stops after 8 failed reads, and wakes you on failed checks, saying it is not a merge decision.

## Decision

- **`watch N` and `unwatch N` on the `github` tool, on by default.** The AI starts a watch when you ask for one ("watch
  #12 and fix CI if it fails"). `github: off` in `/settings` takes it away with the rest of the tool: a running watch
  stops at its next change, with no model turn.
- **Read every 2 minutes with no model call.** One fixed `gh pr view N --json
  state,mergeable,reviewDecision,statusCheckRollup,comments,reviews` through the tool's own gh runner (its environment,
  stop rules and cleaning). Casper keeps what it saw last; the first read is the baseline. An idle watch costs no tokens.
- **A wake only for a change worth a look.** A check failed that was not failing, every check passed, the review
  decision changed, a review or comment came in, or mergeability turned to conflicting (GitHub's "unknown" while it
  works it out keeps the last answer, so one conflict wakes once).
- **A wake starts a turn, without a key.** At the idle prompt it runs at once in place of a typed line; the pending
  read gives way and what you typed stays in the box. While a request runs, one line says what changed and the wake runs
  after that request and the lines queued during it. One wake per pull request waits at a time; later changes join it.
  A desktop notification goes with it when the terminal is not in front (`notifications` in `/settings`).
- **Watches live in the session.** They end when Casper closes. Only an open Casper at a terminal watches: a one-shot
  run, `--json`, an app over ACP or a walk-away job gets a plain refusal, and during a walk-away job no wake runs (a
  change is told in one line that says the AI does not look). Moving to another folder stops them: the tool then reads
  that folder's repo.

## Guard rails

- **Only after a request.** A watch starts only from a request of yours: the tool refuses `watch` while a wake's own turn
  runs, so a wake can never start another watch; `unwatch` works there ("stop watching once CI is green"). At most 5
  at once.
- **Stop rules.** Merged or closed, 8 failed reads in a row, or 10 wakes in a row for comments only (a wake about checks,
  the decision or conflicts starts that count again) each end the watch with one line saying why. `unwatch N` and
  `/tasks` stop one; a stopped watch's waiting wake goes too and its read in flight is aborted.
- **Not typed by you.** The wake goes in as Casper's request, never through the typed-line path: `big model:`, `!command`
  and the other typed-word rules don't read it, it is not echoed as your line, and it says it was not typed by you.
- **No GitHub text in a wake.** It holds the number, the repo and what changed in Casper's own words and counts; the
  state words come from a fixed list. The AI reads the rest with `pr`, `ci` and `comments`, fenced as untrusted, and the
  wake says that text is data, not instructions.
- **Not a merge decision.** The wake says so and asks the AI to do what you asked when you started the watch. The tool
  still can't merge, push, comment or resolve anything.
- `tests/github-watch.test.ts` checks the wake rules, the stop rules, a read held in flight when its watch stops, the
  fixed argv, the refusals and the prompt giving way with the draft kept; `tests/github-watch-app.test.ts` checks a wake
  at the idle prompt, one during a running request after its queued line, the notification (none with `notifications:
  off` or the terminal in front), `/tasks`, that a wake can unwatch but not watch, and the stops for `github: off`, a
  folder move and a walk-away job.
