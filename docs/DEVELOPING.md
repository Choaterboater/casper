# Working on Casper

How to build, test and change Casper.

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

`bun run check` runs `bun run typecheck`, `bun run lint` and `bun test`, and needs no paid model.
`bun run lint` is [oxlint](https://oxc.rs) with only the rules that catch real bugs (`.oxlintrc.json`), no style rules. While you work,
run only the test files you touched: `bun test tests/<name>.test.ts`. Browser and debugger tests skip when those tools are not
installed. Build the program for this machine with `bun run build:release`, or all five
release targets with `bun run build:release -- --all`. [Host testing](PLATFORM_VERIFICATION.md).

The optional [evaluation suite](EVALUATION.md) runs real model tasks and may cost
provider usage: `bun tools/eval.ts --list` shows the tasks.

New here? [How Casper is built](ARCHITECTURE.md): the main pieces, how one request runs, and where to start a change.

Project notes: [design decision](adr/0001-casper-own-product.md),
[eval results](evals/), [pre-release review](PRE_RELEASE_REVIEW.md).

## How changes are made

- Test first: for a change in behaviour, add a test that fails, then make it pass.
- One feature or fix per commit, with a plain one-line message that says what changed for the user.
- Keep words plain and short, in code, docs and messages.
- Nothing personal in code, tests or docs: no real hosts, names, paths or logins.

## Pull requests

Commits are authored by the maintainer; outside changes come as pull requests that the maintainer lands.
Open an issue first for anything large, so we can agree on the shape before you build it.

Security problems: see [docs/SECURITY.md](SECURITY.md) instead of opening a public issue.

### What CI runs, and when

The suite is split in two tiers by `tools/test-tier.ts` (`bun tools/test-tier.ts fast`, `heavy` or `sizes`
lists them). Heavy: a test file that starts real processes or services (a Bun or shell child, git, a PTY or
ConPTY, the browser, a language or MCP server, the sandbox, Bun itself as a server or check command, a
configured check run for real), itself or through a `tests/support` helper it imports (directly or through
another helper), or one that takes over 5 s in `tests/timings.json`. Fast: every other file; some still run
`git` through Casper's own project checks. Each suite file is in exactly one tier, and
`tests/test-tier.test.ts` checks that none is left out.

| Run | Linux | macOS | Windows |
| --- | --- | --- | --- |
| Pull request | whole suite | fast tier; whole suite when it changes a path where OS behaviour matters | the same as macOS, in 4 parts; the build, ConPTY and installer job only with the whole suite |
| Push to `main`, nightly (03:17 UTC), manual run | whole suite | whole suite | whole suite, build and installers |

A release (`publish-release.yml`) stops unless Linux, macOS, Windows and Windows ARM64 each passed a push,
nightly or manual run, which is always the whole suite, on the exact commit it releases. A pull request run
never counts.

Paths where OS behaviour matters (`OS_PATHS` in `tools/test-tier.ts`): `src/platform`, `src/runtime`,
`src/browser`, `src/sandbox`, `src/services`, `src/workspace`, `src/verify`, `src/crew`, `src/agents`, `src/tui`,
`src/lsp`, `src/mcp`, `src/debug`, `src/update`, `src/app/*terminal*`, `src/cli.ts`, `src/cli-main.ts`,
`src/standalone.ts`, `tools/`, `scripts/`, `.github/`, `tests/support/`, `tests/fixtures/`, `package.json`,
`bun.lock`, `bunfig.toml` and `tsconfig.json`. Also any changed `src` file that starts a process or checks the
OS, and any changed heavy test. The changed paths come from `git diff --no-renames HEAD^1 HEAD` on the PR's merge commit (a moved file lists
its old path too);
when they cannot be listed, the whole suite runs. Each run's summary says which tier ran and why. Nearly all of the
suite's time is in the heavy tier, so on macOS and Windows a pull request that only changes words, prompts or
pure logic runs a much shorter suite; Linux still runs everything, and `main` and the nightly run catch the rest.

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

A test that starts the CLI, a Bun child, or a language or MCP server takes its limits from
`tests/support/limits.ts`. Start each child with `finished(() => Bun.spawn(...))`, which guards it with
`CHILD_KILL_MS`. Its test limit is `childTestLimit(n)` for `n` children, which stays above those guards, so a
hang fails on the guard with what the child printed. `finished` starts a child once more, with a fresh guard,
only when the first start printed no byte at all within `SILENT_START_MS` (45 s) and had to be killed: busy
Windows runners sometimes start a Bun child that hangs silently from the start. It prints
`[test guard: child printed nothing for N s; started again once]`. A child that printed anything, or exited by
itself with any code, is never started again, and this is not a test retry. Run fixture programs such as git or a shell line with `run` or `runOk` from
`tests/support/run.ts`, not `spawnSync` or `execFileSync`. A Bun test worker sometimes never reaps a
synchronous child and spins until CI's stall guard ends the job.

On Linux and macOS, `tools/stall-guard.sh` watches the suite (whole or fast tier). When the log has been silent for 180 s it
writes `stall-dump.txt` (every process and what each test worker was doing), stops the run, and runs the
file(s) Bun was still running once more on their own. The step then passes or fails on that run, and the
log says `stall-guard: retried <file> once after a stall`. There is one such retry per job, none after a
failed test, and none when the log names no file. A file that stalls again is a bug to look at, starting from
the dump.

Never make a test pass by weakening what it checks or adding a fixed sleep. A test that waits for something
should wait for the real signal with a deadline (`waitUntil`, `waitForFile` and `processGone` in
`tests/support/wait.ts`).

## Reporting a problem

Include your OS, the command, the exact error, and whether a browser or debugger was installed.
Remove secrets and private paths from logs first.
