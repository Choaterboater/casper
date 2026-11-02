# 56. A check step may accept its dialog; checks bring back the services and leave none of the app's files

Date: 2026-11-02. Status: accepted (merged 2026-11-02 in #574). Amends 55 (the end replay starts a check's own service again) and deliberate
choice 5 (Casper's end-of-task replay).

## Decision

- **A step may accept its dialog.** A browser check's step may say `dialog: "accept"`. The next `confirm`, `prompt` or
  `alert` that step opens gets OK (a prompt gets its default text), and the step's note says `Casper answered OK
  (dialog: accept)`. Every other dialog still gets Cancel, the default, and a leave-page dialog is never accepted.
  A check with such a step is refused unless its page is on this computer (the project's own server), so it never
  answers OK on another site. A check that fails after Cancel (decision 55) now says to record it again this way.
- **A check's other services come back for the end replay.** A check records which of the AI's other services ran
  when it was recorded (a mock its page fetched, a backing API). Casper's end replay starts any of them that stopped,
  as it already starts the check's own service, and stops them once the replays end. When one can't start, a check
  that then fails is not replayed rather than failed: `not replayed: <name> (it needs <service> (<command>), which
  could not start again: …)`.

- **The app smoke leaves no files of its own.** Settings files the app writes as Casper tries it (YAML, TOML, INI) no
  longer make the smoke "not run", as data files already didn't. When Casper started the app, the data and settings
  files are put back afterwards; one that didn't exist is removed.

- **A selector wider than its text is written wrong.** A text assertion that has failed ever since it was recorded,
  because its element holds the expected text inside other text, is written wrong as one matching several elements
  is (decision 55): incomplete, no repair, named on the receipt. It is kept, so the AI can replace it.
- **A start command that ends at once is not checked.** When the app smoke's start command exits 0 within 5 s,
  before serving, the smoke is `not checked — the start command exited before serving`, a note rather than an
  unfinished attempt, so how often it happens shows.

## Why

In the owner's v0.4.4 comparison run (Casper won 79.8 to 73), the run still exited 1:
- Two status-dot checks were recorded while the app's `services.yaml` pointed at the AI's own mock (a second ad-hoc
  service on port 65288). At the end the config came back and the app restarted, but the mock didn't. The dots read
  Down, and the checks failed although the app was right.
- The AI withdrew "Settings remove deletes a widget after confirm" because it could not answer OK. The owner decided
  a step may accept the dialog, with Cancel staying the default.
- In the first runs with these changes, one build wrote its first-run `config/services.yaml` when Casper's app smoke
  started it, naming that run's port. The smoke said files changed (exit 2), and the file shipped in the build.

## Guard rails

- `dialog: "accept"` answers exactly one dialog, from that step, on a page on this computer; the AI's own clicks
  outside checks are unchanged (Cancel).
- The step's click still goes through the same impact rules and holds: a "Remove" or "Delete" label still asks, and
  Browser clicks off still keeps such a step from running.
- Only Casper's end replays start a check's other services, only ones the AI started or the project declares, never
  Casper's own slots, and each is stopped when the replays end.

- The app smoke puts files back only when Casper started the app, never under a service you started.

- A text check that passed once and fails later is a failure, never written wrong; nor is one whose expected
  text no element reads.

A finding: a dialog accepted without the step's `dialog: "accept"`, or on another computer's page; a leave-page
dialog accepted; a service the replay started left running; a check failed because its other service couldn't start.
