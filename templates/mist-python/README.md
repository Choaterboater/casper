# {{name}}

Read-only Mist scripts, started from the Casper `mist-python` template. It uses
[mistapi](https://pypi.org/project/mistapi/) and only makes GET calls.

## Use it

```sh
export MIST_APITOKEN=...        # a read-only Mist API token
export MIST_ORG_ID=...          # or pass --org
uv run {{name}}                 # sites and devices, one line per device
```

`MIST_HOST` picks another Mist cloud (default `api.mist.com`).

## Check it

```sh
uv run pytest        # tests, offline
uv run ruff check .  # lint
```

## Recorded answers

The tests replay answers saved in `tests/cassettes/`. That is sample data, not from your org.
pytest runs with `--record-mode=none`, so a test that calls Mist without a saved answer fails
instead of reaching the network.

Record your own with a read-only token. `once` records tests that have no saved answer yet;
`rewrite` replaces the samples (then change the expected names in the tests to yours):

```sh
MIST_APITOKEN=... MIST_ORG_ID=... uv run pytest --record-mode=once
```

The `authorization` header is never saved (see `vcr_config` in `tests/conftest.py`). Recorded
answers hold your org's real names and addresses: look through them before you commit.
