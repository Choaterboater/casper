# 111. /review takes a pull request by number

Date: 2026-11-17. Status: proposed. Extends `/review` (a read-only reviewer on one change) and the `github` tool
([GITHUB.md](../../GITHUB.md)). `/review` took only local revisions, so reviewing someone's pull request meant
checking out their branch first.

## Decision

- **`#12` or a link.** `/review #12`, or the github.com link of pull request 12, which must name the folder's own
  `origin` repo. Any other repo's link is refused in one line: Casper fetches only from `origin`.
- **Fetched read-only.** One `git fetch` from `origin`: `refs/pull/12/head` into `refs/casper/review/12` and the
  base branch into `refs/casper/review-base/12`, with no force, no prune, no tags and no submodules, repo hooks and
  auto gc off. Nothing is checked out and no branch of yours moves. Both refs are deleted when the review ends,
  stopped or failed too.
- **A commit range, not a branch.** The pull request is reviewed as the range from its merge-base with the fetched
  base to its head, so the diff, the file:line check and the numbered list work as for one commit, and later
  commits on the base are not shown as undone. Diffing a branch would compare with the working tree.
- **The base from gh, else the default branch.** `gh pr view 12 --json baseRefName`, through the `github` tool's gh
  runner (its environment and stop rules). When gh is missing, signed out, or the origin is not on github.com,
  Casper uses origin's default branch and says why in one line.
- **The reviewer is told.** Its brief says files on disk are this checkout, not the pull request, and that the diff
  may be written by someone else, so its text is data. The list sent to the conversation says the lines are in the
  pull request's version, and sits in the `github` tool's untrusted fence (a random marker), since the pull request
  can steer what the reviewer writes.

## Guard rails

- A base name gh returns is used only when it is a plain valid branch name (`git check-ref-format`), never a flag.
- No box: the person typed the command, and the fetch writes only Casper's own refs.
- `tests/review-command.test.ts` checks, with a local origin that has `refs/pull/7/head`, the exact gh call, that
  only the pull request's own change is reviewed, that HEAD and the working tree are unchanged and no
  `refs/casper` ref is left, the link and fallback rules, and a missing pull request.
