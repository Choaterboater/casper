# {{name}}

Ansible for Aruba CX switches, started from the Casper `aoscx-ansible` template. The playbooks
only run `show` commands, against `inventory/lab.yml`.

## Set it up

```sh
uv run ansible-galaxy collection install -r collections/requirements.yml -p collections
export AOSCX_USER=... AOSCX_PASSWORD=...   # a read-only lab account
```

Put your lab switches in `inventory/lab.yml` (the addresses there are documentation examples).

## Use it

```sh
uv run ansible-playbook playbooks/version.yml
uv run ansible-playbook playbooks/show.yml
```

## Check it

```sh
uv run pytest                                             # file checks; no switch, no network
uv run ruff check .                                       # lint for the tests
uv run ansible-lint                                       # after installing the collections
uv run ansible-playbook --syntax-check playbooks/*.yml    # after installing the collections
```

`tests/test_playbooks.py` fails when a playbook uses a module that isn't on its list, or a command
task runs anything but `show`. That says what the files contain; it isn't a promise about the
switch. `ansible-playbook --check` is not a safe dry run on Aruba CX: some modules still apply
changes. Run it only against lab switches.

ansible-core and ansible-lint are GPL-3.0; they are installed into this project, not copied.
