# 74. Casper's checks and rounds leave the app's settings as the AI left them

Date: 2026-11-04. Status: proposed. Extends 69 (Casper's checks leave the app's data as the AI left it) to settings files.

## Decision

A homepage build's requirements review installed "a permanent test weather widget" through the running app, which wrote
it into `config/widgets.yaml` with its key in `config/secrets.yaml`. The round then stopped at its turn budget, nothing
removed the widget, and the app shipped a broken card. Decision 69 copied only SQLite files and data under `data/`,
`db/` and `var/`, so the receipt only said `⚠ Checks and repairs changed app settings or data`.

- **A second copy, of settings.** Next to the data copy, before any check, review, proof or repair round or app smoke
  uses the app, Casper copies the project's YAML, TOML and INI files (not lockfiles), in a copy of their own so a
  project with many of them still has its data copied.
- **Put back after the last check**, byte for byte, also when a round stopped at its turn budget, and settings files
  made since are removed. Casper says which: `↻ put back as the AI left them: config/widgets.yaml (changed while Casper
  checked the work)`, since a round's shell command may have made a real fix there.

## Guard rails

- A file the AI's own edit or write tools changed stays as the AI left it.
- Never a program's output folders, and never `.casper/`.
- Bounded as decision 69: at most 64 files, 64 MB each and 256 MB in all; a project with more is not copied, and its
  settings behave as before. Checks off (`verification: off`) copy nothing.
