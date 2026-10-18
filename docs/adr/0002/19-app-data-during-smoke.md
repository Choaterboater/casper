# 19. The app's own data writes do not void the smoke

Date: 2026-10-18. Status: proposed.

## Decision

Refines the "changes during the run never pass" guard rail of [17](17-try-it-before-done.md). The
completion smoke runs after the model's last turn, so a file that changes while the app is tried was
written by the app itself. Data, database and log files (`.json`, `.jsonl`, `.csv`, `.log`, `.db`,
`.sqlite`, their `-wal`/`-shm`/`-journal` files) no longer turn a pass into `not run`. Before this, any
app that saves data on start or on a GET (`data.json`, SQLite) could never pass the smoke.

## Guard rails

- Code and configuration still void the result, including JSON manifests and tool configs
  (`package.json`, `tsconfig*.json`, `*.config.json`, rc files, `app.json`).
- The receipt still lists the files under `Changed while checking`, and Undo covers them.
- Freshness of reused page and service results is unchanged: they still compare every file.
