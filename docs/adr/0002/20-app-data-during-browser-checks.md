# 20. The app's own data writes keep a browser check fresh

Date: 2026-10-18. Status: proposed.

## Decision

Extends [19](19-app-data-during-smoke.md) to browser checks that name no `scope.inputs`. Those watch
the whole project, so a page that saves (`data.json`, `data/db.json`, SQLite) made every check that adds,
edits or deletes a row stale as it ran. A stale failure gets no repair turn and a stale pass never counts,
so a working app ended `Failed` with no chance to fix the checks. Data files found while walking the
project, and folders that hold only them, are no longer part of the fingerprint.

## Guard rails

- Any edit, write or command of the model still makes every check stale, data file or not.
- A data file named in `scope.inputs` still counts.
- Code and configuration still count, including JSON manifests and tool configs (`package.json`,
  `tsconfig*.json`, `*.config.json`, rc files, `app.json`).
