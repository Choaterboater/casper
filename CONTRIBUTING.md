# Contributing

Thanks for helping with Casper.

## Develop from source

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

`bun run check` needs no paid model. Browser and debugger tests skip when those tools are not
installed. Build the program for this machine with `bun run build:release`, or all five
release targets with `bun run build:release -- --all`. [Host testing](docs/PLATFORM_VERIFICATION.md).

The optional [evaluation suite](docs/EVALUATION.md) runs real model tasks and may cost
provider usage: `bun tools/eval.ts --list` shows the tasks.

Project notes: [design decision](docs/adr/0001-casper-own-product.md),
[eval results](docs/evals/), [pre-release review](docs/PRE_RELEASE_REVIEW.md).

## Run the checks

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
```

`bun run check` runs both. While you work, run only the test files you touched: `bun test tests/<name>.test.ts`.

## How changes are made

- Test first: for a change in behaviour, add a test that fails, then make it pass.
- One feature or fix per commit, with a plain one-line message that says what changed for the user.
- Keep words plain and short, in code, docs and messages.
- Nothing personal in code, tests or docs: no real hosts, names, paths or logins.

## Pull requests

Commits are authored by the maintainer; outside changes come as pull requests that the maintainer lands.
Open an issue first for anything large, so we can agree on the shape before you build it.

Security problems: see [docs/SECURITY.md](docs/SECURITY.md) instead of opening a public issue.

## Reporting a problem

Include your OS, the command, the exact error, and whether a browser or debugger was installed.
Remove secrets and private paths from logs first.
