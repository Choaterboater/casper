# 72. Restore full checking: the AI's own work is checked, proven and repaired by default

Date: 2026-11-04. Status: accepted (merged 2026-11-04 in #594). Amends 44 (trust a folder), 66 (nothing to start is a note), 67 (the tie-break line)
and 68/69 (output folders), and #539's question before a browser repair and #580's checklist wording.

## Decision

The owner's priority: quality first, even with more checks. An audit of every change since v0.3.7 found that several
narrow skips, each right for the case that caused it, together left a build from scratch with little checking: an
interactive session in a new folder ran nothing until "Trust this folder", a new project was never proven, and the
repairs and reminders that catch the builds' repeated misses were off or asked first.

- **A folder with nothing of anyone else's to run is trusted** (amends 44). An empty folder (nothing but `.DS_Store` or
  `.casper`) is trusted and saved: `[trust] Trusted: the folder is empty, so everything Casper checks here is the AI's
  work.` A folder with no code, tests or build files (`package.json`, `Makefile`, `pyproject.toml` …) and nothing
  Casper would run is trusted for that session only, not saved. With the sandbox on, `Trust this folder` is the first
  answer, so Enter trusts; with it off, Not now stays first.
- **A new project is proven.** A task that starts in a folder of at most 500 files with no test command keeps the copy
  from before. When the AI sets up a test command during the task, the change is proven against that copy: without the
  change is the tests, the files the test command needs and the installed dependencies as they are now, and none of the
  code. That copy is never the repair's "failed before this change too" copy.
- **Checklist tests assert exactly their case.** The checklist asks for "one test per case that asserts exactly that
  case, named for that behavior, not after the case's words" again: the 09-27 misses were tests asserting less than
  their case. #580's naming fix stays.
- **Server code that was never started is unfinished** (amends 66). When a changed file opens a server and nothing
  starts it, the receipt says `⚠ Incomplete` with `the app was never started: no start/dev command or declared service
  found for its server`. Anything else with nothing to start (a component, a page another program serves) is still a
  note.
- **A browser check recorded failing in this task is repaired** (replaces #539's question). Every check that fails at
  the end replay was recorded in this task, and the AI is told to check before it edits, so a new feature's check is
  recorded failing. The receipt line `– Save was already failing when it was recorded` stays; the repair turn follows
  with no question, as in `-p`.
- **Only a program's output loses its proof** (amends 68/69). Code under `builds/`, `runs/` or `results/` that the AI's
  own edit and write tools didn't write is left out of the proof; a project's own `reports/` or `out/` package, and code
  the AI wrote anywhere, is proven.
- **Build inputs are not prose.** `requirements*.txt`, `constraints*.txt`, a `requirements/` folder's files,
  `CMakeLists.txt` and `runtime.txt` run the checks; other `.txt` files stay documentation.
- **A build's prompt says the tie-break** (amends 67). Implement tasks get `Sorting by a time? Also sort by the id: rows
  made in one second share a time.` Runs 7, 10 and 11 each lost a shared check or a confirmed defect to it. Two lines of
  the task prompt were shortened so the fixed prompt stays under its budget.
- **A build reviews its own work before it is done.** When the checks pass on an implement request that changed code,
  the model gets the requirements review round, then one self-review turn (at most 6 turns) on transactions, durable
  state, input types, ordering ties and the README; the checks run again if either edited. Measured on three Sonnet 4.6
  tracker builds per option against run 11's omp build, with one blind reviewer and a separate defect confirmer:

  | Option | Casper − omp (median) | Shared checks failed | Output tokens (median) | Wall time (median) | Exit codes |
  |---|---|---|---|---|---|
  | none (base) | −18.9 | 3 of 3 runs | 85.9k | 17.0 min | 0, 2, 0 |
  | review round | −14.1 | 0 | 116.8k | 27.1 min | 2, 1, 2 |
  | self-review turn | −16.1 | 0 | 94.1k | 20.5 min | 2, 2, 1 |
  | **both** | **−9.3** | **0** | **81.5k** | **16.7 min** | **0, 0, 0** |
  | cross-model acceptance | −16.1 | 1 of 3 | 93.0k | 18.3 min | 0, 0, 0 |
  | first-turn requirements line | −18.7 | 1 of 3 (3 checks) | 80.2k | 16.3 min | 0, 0, 0 |

  Every build with both rounds scored above every build with none (45.4–53 against 40–45.2).

  `verification.review: false` turns it off. The cross-model acceptance check stays off by default: it caught the
  ordering bug in all three runs, but scored no better overall and raised false alarms (20 on one build that passed
  every shared check).

## Guard rails

- A folder holding code, tests or build files that Casper didn't make still asks, Not now first unless the sandbox is
  on. A clone with only an `install.sh` asks. Home and the top of a drive are never trusted. A folder too big to look
  through counts as holding code.
- Only an empty folder's trust is saved without a person's answer; the other automatic trust lasts one session.
- The new-project proof never runs on a folder larger than 500 files at the start, and a failure on the copy from before
  never stops a repair.
- A command check that failed before the change still asks `Fix it anyway?` with Leave it first: it has a real copy of
  the code from before.
- Output from a program (a comparison's builds) still asks for no proof and starts no app smoke.

## A finding

- A folder with code, tests or build files is trusted without a person's answer.
- With the sandbox off, Enter trusts a folder.
- A new project's failing check is read as failing before the change.
- A browser check recorded failing in an earlier task drives a repair without being replayed in this one.
- Code the AI wrote under `builds/`, `runs/` or `results/` is left out of the proof.
