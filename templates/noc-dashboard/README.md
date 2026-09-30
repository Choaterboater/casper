# {{name}}

A NOC dashboard in [Streamlit](https://streamlit.io), started from the Casper `noc-dashboard`
template. It shows which Mist devices are up and down, down first. Read-only: GET calls only.

## Use it

```sh
uv run streamlit run src/{{module}}/app.py
```

With no token it shows sample data (`src/{{module}}/fixtures/`), not from your org. For your org:

```sh
export MIST_APITOKEN=...   # a read-only Mist API token
export MIST_ORG_ID=...
uv run streamlit run src/{{module}}/app.py
```

`MIST_HOST` picks another Mist cloud. `NOC_SOURCE=fixtures` forces the sample data.
`NOC_SOURCE=central` is a placeholder: Central isn't built in yet.

## Check it

```sh
uv run pytest        # data tests and the page itself (Streamlit AppTest, sample data)
uv run ruff check .  # lint
```

`.casper/project.yaml` tells Casper how to start the page (`services.dashboard`), so Casper
can open it after a change.
