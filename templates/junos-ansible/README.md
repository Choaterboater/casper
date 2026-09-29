# {{name}}

Ansible for Junos, started from the Casper `junos-ansible` template. The playbooks gather facts
and run `show` commands against `inventory/lab.yml`. `checks/render.yml` turns settings into Junos
config text on this machine (`state: rendered`), without contacting a device.

## Set it up

```sh
uv run ansible-galaxy collection install -r collections/requirements.yml -p collections
export JUNOS_USER=... JUNOS_PASSWORD=...   # a read-only lab login class
```

Put your lab devices in `inventory/lab.yml` (the addresses there are documentation examples).
The playbooks use NETCONF (port 830): turn it on with `set system services netconf ssh`.

## Use it

```sh
uv run ansible-playbook playbooks/facts.yml
uv run ansible-playbook playbooks/show.yml
uv run ansible-playbook checks/render.yml   # no device contacted
```

## Check it

```sh
uv run pytest                                             # file checks, and the render once collections are installed
uv run ruff check .                                       # lint for the tests
uv run ansible-lint                                       # after installing the collections
uv run ansible-playbook --syntax-check playbooks/*.yml    # after installing the collections
```

`tests/test_playbooks.py` fails when a playbook uses a module that isn't on its list, a command
task runs anything but `show`, or a `checks/` task doesn't render. That says what the files
contain; it isn't a promise about the device.

ansible-core, ansible-lint and the junipernetworks.junos collection are GPL-3.0; they are
installed into this project, not copied.
