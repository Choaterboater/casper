# 109. A lock says who holds it, and a gone holder's lock is taken over

Date: 2026-11-17. Status: proposed. Changes what [MEMORY.md](../../MEMORY.md) and [LEARNING.md](../../LEARNING.md)
said: "a stale lock is not removed for you" and "interrupted locks are not stolen".

Casper's own state files are changed under a lock folder made with `mkdir`: memory (`memory.jsonl.lock`,
`outcomes.jsonl.lock`), saved session branches, learning drafts and promotions, and worktree creation. The folder
said nothing about who made it and never expired. A Casper killed inside the few milliseconds it held one (a closed
terminal at the wrong moment, a crash, a restart) left it there for good, and every later update stopped with
"Memory state is locked; no update made" until you found the folder and removed it yourself. T3 Code's locks record
their holder's pid and when the computer started; this follows that.

## Decision

- **The lock says who holds it.** The folder (`0700`) holds one owner file (`0600`) named
  `owner.<pid>.<boot>.<host>.<id>`: the holder's pid, when this computer started (`boot`, whole seconds: now less
  `os.uptime()`), which computer (`host`: 8 hex characters of a hash of its host name, not the name) and a random
  id. The same JSON is in the file for a person reading it. One helper,
  `withStateLock` in `src/platform/state-lock.ts`, is used at every site; each keeps its own tries (100 × 20 ms),
  its abort signal and its words for a lock that is really busy.
- **A gone holder's lock is taken over.** A waiter takes the lock over when the owner's boot differs from this
  computer's by more than 60 s (it restarted since, so the pid may belong to another program now), or when its pid is
  gone (`process.kill(pid, 0)` says `ESRCH`) and its owner file is older than 2 s. A process of another user, or any
  other answer, counts as alive. A folder with no owner file (an older Casper's lock) is taken over once it is older
  than 5 minutes.
- **Another computer's lock is judged by age alone.** A home folder shared over the network gives two computers
  the same lock folders, and a boot or pid from one says nothing on the other. An owner whose `host` is not this
  computer's is taken over only once its file is older than 5 minutes, never for its boot or pid.
- **Taking over is race safe without a second lock.** A stale owner file is removed by its exact name, which is
  unique to one holder, and then the folder with `rmdir`, which removes only an empty folder: never one a holder has
  written its file into. A holder, after writing its file, checks it is the only one in the folder; two that wrote
  into the same folder at once both step back and try again. So two waiters that find the same stale lock never both
  hold it, and a waiter that judged a lock stale and acts late never removes a new holder's lock.
- **Releasing** removes the holder's own file, then the empty folder. If its file is gone, another Casper took the
  lock over, and the folder is left to it. A release that fails leaves a file whose pid is soon gone, so the next
  waiter takes it over.
- **Walk-away jobs** (decision 51) record `boot` too. A running or waiting job reads as stopped (and no longer blocks
  a new job in its folder) when its boot differs from this computer's by more than 60 s and this computer started
  after the job was left (`leftAt`), even when its pid is in use again. A job runs for hours, so a changed boot alone
  is not enough: a clock set forward moves it too. A record without `boot` (an older Casper's) is judged by its pid
  alone, as before. No `ps` is run.

## Guard rails

- Nothing of yours is removed: only the lock folder and its owner file go. The state files are untouched, and an
  invalid one still stops the update with the same error.
- A live holder is never taken over: the same pid on the same boot, or another live pid, waits and then fails with
  the site's own words.
- Pi's `settings.json.lock` (`src/runtime/pi-models.ts`) keeps its own rules: it matches Pi's lock library, and a
  stale one there stays a visible failure.
- A clock moved by more than 60 s while a lock is held makes its boot look different, so that lock can be taken over.
  Locks are held for milliseconds (worktree creation for seconds), so this is accepted. A job is not judged gone by
  its boot alone: a clock moved forward more than the time between the computer's start and the job's start is the
  one case that still reads a live job as stopped.
- A computer whose host name changes (some take one from the network) sees its own older locks as another
  computer's: a killed holder's lock then waits 5 minutes instead of 2 s, which is accepted.
- `tests/state-lock.test.ts` checks a live owner keeps the lock, a gone pid's lock is taken over only after 2 s, an
  owner from an earlier boot is taken over, an owner on another computer is taken over only by age, an ownerless folder is taken over only after 5 minutes, two waiters that
  find the same stale lock take turns, a late waiter never takes a new holder's lock, and a killed Casper's lock
  no longer blocks memory, saved session branches or worktree creation; `tests/phase9-learn.test.ts` checks the same
  for learning drafts and promotions. `tests/walk-away.test.ts` checks a new job records its boot, a job from before a
  restart reads as stopped, and a clock set forward does not stop a live one.
