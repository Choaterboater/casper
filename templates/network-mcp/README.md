# {{name}}

An MCP server for your network, started from the Casper `network-mcp` template. It uses the
official MCP Python SDK 2.x (`MCPServer`).

## What it has

- `access_check`: asks Mist what your token may do (`GET /api/v1/self`) and answers in the
  `casper/access-check v1` shape, so Casper can show "login: read-only (checked)".
- Every tool says whether it changes things (`readOnlyHint` / `destructiveHint`).
  `tests/test_read_only_labels.py` fails when a tool doesn't.
- Write tools stay off unless `{{env}}_READ_ONLY=false`. There are none yet.

## Settings

| Name | What |
| --- | --- |
| `MIST_API_TOKEN` | a Mist API token; use a read-only one |
| `MIST_HOST` | the Mist API host, default `api.mist.com` |
| `{{env}}_READ_ONLY` | `true` (default) keeps write tools off |

Never put a real token in a file. `.mcp.json.example` and `examples/mcp.json` use
`${MIST_API_TOKEN}` from your shell.

## Check it

```sh
uv run pytest                 # tests, in memory; no network
uv run ruff check .           # lint
casper mcp check --quick .    # Casper's MCP checks (offline)
```

The tests use sample data, not from your org. `respx` stands in for the Mist API. To record
real answers instead, write a test marked `@pytest.mark.vcr` and run
`uv run pytest --record-mode=once` with a read-only token; the `authorization` header is never
saved. Look through the recorded file before you commit it.

## Run it

```sh
MIST_API_TOKEN=... uv run {{name}}
```
