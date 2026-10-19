# 21. End replays start from the data each check was recorded with

Date: 2026-10-19. Status: accepted (owner's choice).

## Decision

Refines [5](../0002-deliberate-choices.md) (end-of-task replay) and [20](20-app-data-during-browser-checks.md).
When a browser check of a local page is recorded, Casper keeps a copy of the project's app data files (the
`appDataFile` list: `data.json`, `.jsonl`, `.csv`, logs, SQLite and its `-wal`/`-shm`). Before an end-of-task
replay of that check it restores them (a file absent then is removed) and restarts the server Casper runs, so
the app reads them afresh. After all replays the data as the AI left it is restored and the server restarted.

Before, replays ran on whatever data was there. A small model wrote its checks as a chain (each expecting the
totals the one before left), then deleted `data.json`; the replays then failed a working app. On 2026-10-17
the owner had chosen to leave replay writes as they are; this replaces that choice: replays now leave none.

## Guard rails

- Only data files, never code, manifests or configuration (`package.json`, `tsconfig*.json`, `*.config.json`,
  rc files, `app.json`), and only in the project folder outside dependency, build and cache folders.
- Bounded: at most 32 files, 1 MiB each, 8 MiB in all; a project with more is replayed on the data as it is.
- Nothing is restored or restarted when the data already matches, so a replay costs no restart for nothing.
- A server Casper doesn't run is never restarted; the check notes that the app may hold other data. A server
  that fails to restart leaves the same kind of note, never a crash of the replay.
- The model's own `replay` during the task is unchanged: it runs on the data as it is.
