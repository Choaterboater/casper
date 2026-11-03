# 68. Data the task's own runs left is the task's, and the AI is told

Date: 2026-11-03. Status: accepted (merged 2026-11-03 in #583).

## Decision

A tracker build shipped `data/tracker.db` holding the user and session the AI's own test run signed up, so on a fresh
install the first person to register was not the admin. The AI had started its server with `PORT=3456 node src/server.js
&`; the database was written while no tool of the AI's ran, and a running app's database is another program's, so the
receipt said `Changed by something else while Casper worked (not checked): data/tracker.db, …`.

- **New, and the task could have written it: the task's.** A data file that was not there before the task (a SQLite
  database with its `-wal` and `-shm`, or JSON, YAML or CSV under a `data/` or `db/` folder, never in a program's output
  folder), when the task ran a shell command, a service or the browser, is the task's: undo removes it, and it is never
  `Changed by something else`.
- **The AI is told once.** While such a file is still there after the AI's turn, Casper sends one short note naming it
  and what it holds (`data/tracker.db (2 rows in 2 tables)`), and asks the AI to delete it unless it is meant to ship.
  This is one extra model round, only when such a file is left.
- **The receipt names what is still there**, in grey: `– Left by your test runs: data/tracker.db (2 rows in 2 tables);
  it ships with the app unless you delete it`.

## Guard rails

- A data file that was there before the task (a real app's live database, the Home Assistant case) stays the running
  app's, also its new `-wal`; nothing is said to the AI about it.
- The database is only read (opened read only, never written) to count its rows and tables.
- No note when the task stopped, failed, or hit its turn or spend limit. App smoke and browser checks already put back
  the data they wrote (decisions 19 and 20).
