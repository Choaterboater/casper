# 30. Untracked files don't hold back a checkout's own update

Date: 2026-10-22. Status: accepted (merged 2026-10-22 in #472). Changes the checkout guard rail of
[decision 14](14-background-updates.md) ("no local commits or untracked files"); decision 14 is otherwise unchanged.

## Decision

The background update fast-forwards a source checkout that has untracked files, as long as it is on origin's default
branch, tracks it, and has no uncommitted changes to tracked files and no local commits. When it leaves a checkout
alone, the notice above the prompt says why in a few words: `Casper update ready · checkout has uncommitted changes ·
casper update`, or `checkout on another branch`, `checkout tracks another upstream`, `checkout has local commits`,
`default branch unknown`.

A checkout someone works in collects untracked notes, drafts and editor files. Holding the update back for them left
such a checkout many changes behind, with only `Casper update ready · casper update` and no reason, while a manual
`casper update` pulled it at once.

## Guard rails

- Still a fast-forward only (`git merge --ff-only` of the upstream the daily check fetched): no stash, rebase, reset
  or branch switch, and nothing is deleted.
- Git refuses a fast-forward that would overwrite or remove an untracked file. That is reported like any failed
  update (`update failed · casper update` and `~/.casper/update.log`); nothing is forced, and `casper update` says
  the checkout has changes in the way.
- Uncommitted changes to tracked files, another branch or upstream, an unknown default branch and local commits still
  hold it back, as before.
- The reason is the last attempt's. It stays with that HEAD until the next attempt (at most daily), and a reason
  Casper doesn't know is left out of the notice.

A finding: an untracked file overwritten or removed by a background update, a held checkout changed, or a forced,
stashed or rebased checkout.
