# Contributing

Thanks for helping with Casper.

## Develop from source and run the checks

Needs Bun, Git, and Python 3 (for the POSIX terminal tests):

```sh
git clone https://github.com/Choaterboater/casper.git
cd casper
bun install --frozen-lockfile
bun run dev
bun run check
```

To run the checkout as `casper`, link `src/cli.ts` to `~/.local/bin/casper` (run
`chmod +x src/cli.ts` first). `casper --version` prints `casper <version> (<path>)`, so a stale
link is easy to spot. The release installer will not replace such a link without `--force`.
In a checkout, `casper update` pulls (fast-forward only, never forced) and runs
`bun install --frozen-lockfile` when `bun.lock` changed. A session in a checkout says how many
changes it is behind, the same way.

Rules for coding agents and anyone changing this repo (branches, what to run before a PR, what needs review) are in `CLAUDE.md`.

`bun run check` runs `bun run typecheck`, `bun run lint` and `bun test`, and needs no paid model.
`bun run lint` is [oxlint](https://oxc.rs) with only the rules that catch real bugs (`.oxlintrc.json`), no style rules. While you work,
run only the test files you touched: `bun test tests/<name>.test.ts`. Browser and debugger tests skip when those tools are not
installed. Build the program for this machine with `bun run build:release`, or all five
release targets with `bun run build:release -- --all`. [Host testing](docs/PLATFORM_VERIFICATION.md).

The optional [evaluation suite](docs/EVALUATION.md) runs real model tasks and may cost
provider usage: `bun tools/eval.ts --list` shows the tasks.

New here? [How Casper is built](docs/ARCHITECTURE.md): the main pieces, how one request runs, and where to start a change.

Project notes: [design decision](docs/adr/0001-casper-own-product.md),
[eval results](docs/evals/), [pre-release review](docs/PRE_RELEASE_REVIEW.md).

## How changes are made

- Test first: for a change in behaviour, add a test that fails, then make it pass.
- One feature or fix per commit, with a plain one-line message that says what changed for the user.
- Keep words plain and short, in code, docs and messages.
- Nothing personal in code, tests or docs: no real hosts, names, paths or logins.

## Pull requests

Commits are authored by the maintainer; outside changes come as pull requests that the maintainer lands.
Open an issue first for anything large, so we can agree on the shape before you build it.

Security problems: see [docs/SECURITY.md](docs/SECURITY.md) instead of opening a public issue.

### If CI is red on your PR

Most red runs mean the change broke something. Some are a flaky test: one that fails now and then on a busy
CI runner, whatever the change. To tell which:

1. Open the failed job and find the `(fail)` line: it names the test and its file.
2. Run that file alone on your machine: `bun test tests/<name>.test.ts`. If it fails there too, it is real.
3. If it passes alone and the test has nothing to do with your change, use **Re-run failed jobs** on the run
   (or ask on the PR if you can't). A flake passes on the rerun; a real failure fails the same way again.
4. A test that times out at its limit (`timed out after 30000ms`) on one OS only, and passes on the others,
   is most often a flake. Say so on the PR.

The known flaky tests already get one more try on the OS they flake on, and only when the first try runs out
of time. The list is in `tests/flaky-list.test.ts`. When the first try times out, the log shows a `(retry)`
line with the test's name. The timed-out try is left to finish on its own, and its late result is ignored. A
first try that fails with a wrong result fails the test at once.

To add one: it must start a real child process (Bun, a language server, git) and have failed on CI for no
reason in the change. Write it as `flakyOn("win32")("name", async () => { ... }, 60_000)` (the OS it flaked
on, and its limit for one try), and add its file, name and OS to the list in `tests/flaky-list.test.ts`.
Nothing else may retry: never a test without a child process, never a test that failed with a wrong result
rather than a slow one (that is a bug to fix), and never the whole suite.

Never make a test pass by weakening what it checks or adding a fixed sleep. A test that waits for something
should wait for the real signal with a deadline (`waitUntil`, `waitForFile` and `processGone` in
`tests/support/wait.ts`).

## Reporting a problem

Include your OS, the command, the exact error, and whether a browser or debugger was installed.
Remove secrets and private paths from logs first.
