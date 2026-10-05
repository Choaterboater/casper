# Contributing

Thanks for helping with Casper.

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
