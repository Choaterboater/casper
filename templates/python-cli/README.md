# {{name}}

A command-line tool, started from the Casper `python-cli` template.

## Use it

```sh
uv run {{name}} --help
uv run {{name}} hello --who team
```

## Check it

```sh
uv run pytest        # tests
uv run ruff check .  # lint
```

The code lives in `src/{{module}}/cli.py` and the tests in `tests/`.
