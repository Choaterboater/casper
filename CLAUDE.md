# Notes for Claude

- Commits are authored by the repo owner only: `Choaterboater <280862039+Choaterboater@users.noreply.github.com>`.
  The `.claude/settings.json` startup hook sets this; check `git config user.name` before committing.
- Never add `Co-Authored-By` lines, `Claude-Session` links, or "Generated with Claude Code" text
  to commits, pull request descriptions, or comments.

## Working on this repo (agents and people)

- Changes ship as small PRs from a branch made from a fresh `origin/main`. The owner merges and publishes. Never push to `main`, tag, or publish a release.
- Only real accounts and Casper's own `Choaterboater` identity may author commits here. No bots (Dependabot is removed: dependency and GitHub Action pin updates are made as ordinary PRs by Casper), no other AI names, no tool-added trailers.
- Before a push: `git fetch`; `git merge-base HEAD origin/main` equals `origin/main`; one commit unless told otherwise; `git log -1 --format='%an <%ae>'` shows the identity above; grep the added lines for personal names, device names, MAC addresses, org ids and local paths (none belong in code, tests, docs or commit messages: use placeholders such as `192.0.2.x` and `02:00:00:...`). Add files by name, never `git add -A`.
- Run several test files with `bun test --parallel a.test.ts b.test.ts` (without `--parallel` most files get a 5 s limit and time out for no reason). After pulling, run `bun install --frozen-lockfile`.
- Before opening a PR run `bun run typecheck`, `bunx oxlint`, every test file that mentions the files you changed, and always `tests/doc-claims.test.ts`, `site.test.ts`, `help-text.test.ts`, `path-inside.test.ts`, `fixed-tokens.test.ts`. Docs and the site are part of a change.
- Use `isOutside` from `src/platform/inside` for path checks, never a hand-written `startsWith("..")`. Do not use Windows-invalid file names in tests. A request must not grow the fixed prompt: `fixed-tokens` fails first, so shorten text before raising its cap.
- A known slow test uses `flakyOn("win32")` and the list in `tests/flaky-list.test.ts`; read the real failing line of a red job before calling it a flake or re-running it.
- A change to the sandbox, approval boxes, the private-places list, secrets handling or `.github/workflows` needs the owner's review before merge: say so in the PR.
- A PR stacked on another one is rebased after the first is squash-merged by cherry-picking only its own commit onto the new `origin/main`.
