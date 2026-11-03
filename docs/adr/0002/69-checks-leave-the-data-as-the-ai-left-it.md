# 69. Casper's checks leave the app's data as the AI left it

Date: 2026-11-03. Status: proposed. Extends 19 and 20 (app data during the smoke and browser checks) to the whole check
phase of a task.

## Decision

A tracker build shipped `data/tracker.db` holding 6 users and 6 sessions. The AI had deleted its own test database when
Casper told it to (decision 68); then a repair round's browser recording, the end replays of the browser checks and the
app smoke signed users up again. Each of those put back only what it wrote within itself, and the receipt said
`⚠ Checks and repairs changed app settings or data`.

- **One copy for the whole check phase.** After the AI's turn (and its note about test data), before any check, replay,
  repair round or app smoke uses the app, Casper copies the app's data files: SQLite databases with their `-wal`, `-shm`
  and `-journal` files, and JSON, YAML or CSV data under a `data/`, `db/` or `var/` folder.
- **Put back after the last check**, byte for byte, and data files the checks made are removed, so the app ships as the
  AI left it.

## Guard rails

- Never a program's output folders (`builds/`, `runs/`, `results/` at any depth, `logs/`): a job still running there
  (a comparison) keeps what it writes.
- A file the AI's own edit or write tools changed during a repair round stays as the AI left it.
- Bounded: at most 64 files, 64 MB each and 256 MB in all; a project with more is not copied, and its checks behave as
  before. Manifests and lockfiles are never data.
- Checks off (`verification: off`) copy nothing.
