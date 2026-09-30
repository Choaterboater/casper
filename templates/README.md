# Casper templates

Each folder here is one `casper new` template: real files plus a `template.json` manifest.
`bun run scripts/pack-templates.ts` packs them into `src/new/templates.generated.ts`, so the
compiled binary carries them.

## Rules

- Paths: a `__module__` folder becomes the Python module name (`mist-aps` → `mist_aps`). A name
  starting with `dot.` becomes a dotfile (`dot.gitignore` → `.gitignore`), so template files never
  act as this repo's own dotfiles. A file ending in `.append` is added to the end of the file the
  init tool wrote (`pyproject.toml.append`).
- Text: `{{name}}`, `{{module}}`, `{{env}}` (upper-case module, `MIST_APS`) and `{{year}}` are filled
  in. Anything else in braces (Jinja's `{{ var }}`) is left alone.
- A template file never overwrites a file the init tool wrote unless the manifest lists it in
  `replace`.
- Versions: every change to a template's files needs a higher `version` in its `template.json`,
  then `bun run scripts/pack-templates.ts --lock` (records the new hash in `VERSIONS.json`).
  `tests/new-templates-version.test.ts` fails otherwise. The version goes into the first commit
  of every project made from it.
- No real org data and no secrets. Sample data says so. Tokens come from the environment.

## Templates

| id | tool | tests at creation |
| --- | --- | --- |
| python-cli | uv | pytest, ruff |
| network-mcp | uv | pytest (in-memory MCP client, respx), ruff; passes `casper mcp check --quick` |
| mist-python | uv | pytest against recorded sample answers (pytest-recording, `--record-mode=none`), ruff |
| web-app | bun (`bun init --react`) | bun test with happy-dom, `tsc --noEmit` |
| noc-dashboard | uv | pytest with Streamlit AppTest over sample data, ruff |
| aoscx-ansible | uv (`--bare`) | pytest file checks, ruff |
| junos-ansible | uv (`--bare`) | pytest file checks, plus the render check once collections are installed, ruff |

## Not a template: mist-terraform

Left out on purpose. `terraform init` must download the Mist provider from the Terraform
registry, so a new project can't run its first check offline; Casper detects no Terraform checks
to run; Terraform itself is under the BSL, not an open-source licence; and Terraform isn't a common
need yet. It is on the Next list.
