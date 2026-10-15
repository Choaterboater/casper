# Notes for coding agents (Casper, Claude and others)

- Commits are authored by the repo owner only: `Choaterboater <280862039+Choaterboater@users.noreply.github.com>`.
  The `.claude/settings.json` startup hook sets this; check `git config user.name` before committing.
- Never add `Co-Authored-By` lines, `Claude-Session` links, or "Generated with Claude Code" text
  to commits, pull request descriptions, or comments.

## Working on this repo (agents and people)

- Changes ship as small PRs from a branch made from a fresh `origin/main`. The owner merges and publishes. Never push to `main`, tag, or publish a release.
- Only real accounts and Casper's own `Choaterboater` identity may author commits here. No bots (Dependabot is removed: dependency and GitHub Action pin updates are made as ordinary PRs by Casper), no other AI names, no tool-added trailers.
- Before a push: `git fetch`; `git merge-base HEAD origin/main` equals `origin/main`; one commit unless told otherwise; `git log -1 --format='%an <%ae>'` shows the identity above; grep the added lines for personal names, device names, MAC addresses, org ids and local paths (none belong in code, tests, docs or commit messages: use placeholders such as `192.0.2.x` and `02:00:00:...`). Add files by name, never `git add -A`.
- Never change the configured check (`.casper/project.yaml`, quick-test scripts) to narrow or speed it up; run targeted `bun test` commands directly instead.
- While working, run typecheck, lint and only the tests the change touches. Run the full set once at the end with `bun test --parallel=4` (at most 4); CI runs everything. After pulling, run `bun install --frozen-lockfile`.
- Build with at most 2 Casper sessions/crews on one machine at a time.
- Make tests full-suite safe: never mutate global env/platform state directly or depend on developer git config, HOME, terminal or tmux. Pass `cleanEnv` to children; use serial `withEnv` fixtures from `tests/support/env.ts` for in-process env and restore afterwards. Never patch built-ins globally; pass fixture homes or launch children with HOME/USERPROFILE set. Use `privateTmux` for screens: private `tmux -L`, throwaway HOME.
- Never merge on a green rerun when the PR's own new or changed tests failed. Prove a suspected flake with `.github/workflows/deflake.yml` first, then fix it or list its owner, OS and reason in `tests/known-flaky.ts`.
- Claim colours/layout only when a named test checks them; capture actual ANSI bytes for colour checks (see `tests/approval-ansi.test.ts`).
- Feature PRs do not edit `docs/RELEASE.md`, the roadmap's Built, not released box or an existing ADR file. Prepare release notes at release time; put new decisions in `docs/adr/0002/<NN>-<slug>.md`.
- Screen/process/file tests poll the expected condition, never read once after an action. Before committing, run new/changed timing tests with `--rerun-each=5`, including under load.
- Before opening a PR run `bun run typecheck`, `bunx oxlint`, related tests and the final full run above, including `tests/doc-claims.test.ts`, `site.test.ts`, `help-text.test.ts`, `path-inside.test.ts`, `fixed-tokens.test.ts`. Docs and the site are part of a change.
- Use `isOutside` from `src/platform/inside` for path checks, never a hand-written `startsWith("..")`. Do not use Windows-invalid file names in tests. A request must not grow the fixed prompt: `fixed-tokens` fails first, so shorten text before raising its cap.
- A known slow test uses `flakyOn("win32")` and the list in `tests/flaky-list.test.ts`; read the real failing line of a red job before calling it a flake or re-running it.
- Reviewers (AI or human) read `docs/adr/0002-deliberate-choices.md` and decisions in `docs/adr/0002/` before flagging permission or security behaviour: a listed choice is not a finding unless its guard rail is broken.
- A change to the sandbox, approval boxes, the private-places list, secrets handling, `.github/workflows` or `AGENTS.md` needs the owner's review before merge: say so in the PR.
- A PR stacked on another one is rebased after the first is squash-merged by cherry-picking only its own commit onto the new `origin/main`.
