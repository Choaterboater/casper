---
name: network-junos-pyez
description: >-
  How to automate Junos from Python with PyEZ or NETCONF: facts, RPCs, tables, display set/xml/json,
  commit check first, confirmed commits, rollback, testing with saved RPC replies.
tags: [junos, pyez, junos-eznc, netconf, juniper.device]
casper-skill:
  platform: junos
  triggers:
    strong: ["pyez", "junos-eznc", "jnpr.junos", "juniper.device", "junipernetworks.junos", "junos pyez", "junos netconf", "commit confirmed"]
    weak: ["junos", "display set", "commit check"]
  frameworks: [junos]
  version: 3
---
# Junos with PyEZ and NETCONF

## When to use
Code that talks to a Junos device (MX, EX, QFX, SRX) over NETCONF on SSH: PyEZ
(`jnpr.junos`, PyPI `junos-eznc`), `ncclient` or Ansible. Devices run from Mist: use the
Mist skill (the cloud may overwrite changes made on the box).

## Sign-in and tokens
- Login from the environment only: `JUNOS_HOST`, `JUNOS_USER`, `JUNOS_PASSWORD` (the names
  `casper new junos-ansible` uses), or an SSH key. Never in code, output, logs or samples.
- Use a lab login class with the least rights the task needs. Only the product's own
  access check decides what a login may do.
- NETCONF must be on: `set system services netconf ssh` (port 830, PyEZ's default).
- PyEZ does not check the SSH host key unless you pass `hostkey_verify=True`: do.

```python
import os, sys
from jnpr.junos import Device
from jnpr.junos.exception import ConnectError, RpcError, RpcTimeoutError

def open_device():
    host, user = os.environ.get("JUNOS_HOST"), os.environ.get("JUNOS_USER")
    if not (host and user):
        sys.exit("Set JUNOS_HOST and JUNOS_USER (and JUNOS_PASSWORD or an SSH key)")
    dev = Device(host=host, user=user, passwd=os.environ.get("JUNOS_PASSWORD"),
                 hostkey_verify=True, conn_open_timeout=15, gather_facts=False)
    try:
        dev.open()
    except ConnectError as e:
        sys.exit(f"Cannot open NETCONF to {host}: {type(e).__name__} (port 830 on? login?)")
    dev.timeout = 60  # seconds per RPC; default is 30
    return dev
```

## Read first
These calls ask for data. Run them first to learn the device.
- `dev.facts` (after `dev.facts_refresh()`): hostname, model, version, serial.
- `dev.rpc.get_software_information()`, `get_interface_information(terse=True)`,
  `get_lldp_neighbors_information()`, `get_config(filter_xml="system/services")`.
- The RPC name for a show command: on the CLI, `show interfaces terse | display xml rpc`.
  `| display xml` shows the reply tags, `| display json` the JSON form.
- Config as set lines: `show configuration | display set`. Over NETCONF,
  `get_config(options={"format": "text"})`; set format: check the current docs.

```python
from jnpr.junos.op.lldp import LLDPNeighborTable
dev = open_device()
try:
    rep = dev.rpc.get_interface_information(terse=True, normalize=True)
    for ifd in rep.findall("physical-interface"):
        print(ifd.findtext("name"), ifd.findtext("oper-status"))
    for n in LLDPNeighborTable(dev).get():
        print(n.local_int, n.remote_sysname, n.remote_port_id)
except RpcTimeoutError:
    print("RPC timed out: raise dev.timeout or ask for less")
except RpcError as e:
    print(f"RPC error: {e}")
finally:
    dev.close()
```

`dev.cli()` is for debugging only (PyEZ says so): use RPCs in code.

## Changing things (Casper asks)
MCP: Casper's change box asks; don't ask again in chat. Else ask the user first; show the exact call.
Casper also asks before a shell command reaches a new host.
Order: load, show the diff, commit check, commit confirmed with minutes, then a plain commit.

```python
# WRITE
from jnpr.junos.utils.config import Config
from jnpr.junos.exception import CommitError, ConfigLoadError, LockError
try:
    with Config(dev, mode="exclusive") as cu:  # lock; unlocks on exit
        cu.load(path="changes/ntp.set", format="set")
        cu.pdiff()  # show | compare
        cu.commit_check()  # device checks, no commit
        cu.commit(confirm=5, comment="ntp")  # rolls back in 5 min unless confirmed
        # check the device, then the user decides:
        if input("Device OK? Type yes to keep it: ") == "yes":
            cu.commit(comment="confirm ntp")
except (LockError, ConfigLoadError, CommitError) as e:
    print(f"Stopped: {e}. Tell the user what did and did not commit.")
```

- `cu.load()` default action is replace (acts on `replace:` tags); for text or XML pass
  `merge=True` unless the user asked for replace. `overwrite=True` replaces the whole config.
- An unconfirmed commit rolls back by itself when the timer ends; a slow script can miss
  it. `commit check` also confirms.
- WRITE: undo before commit: `cu.rollback(0)`; after: `cu.rollback(1)` then commit.
- WRITE: `request system configuration rescue save` (known-good copy; `rollback rescue`
  loads it back), reboot, software install, zeroize.
- Many devices: one test device first, then one at a time; stop at the first error and say
  what changed where.
- `juniper.device.config` commits by default when `load` is set: pass `commit: false`
  and `check: true` for a check only (Casper's `junos-commit` lab check does this).

## Paging and rate limits
- No paging: each RPC returns all it has. Ask for less (`interface_name`, `filter_xml`,
  `terse=True`); big tables (routes, MACs) can pass `dev.timeout`.
- Reuse one session per device.

## Common traps
- Config mode: `exclusive` locks the shared candidate (LockError if someone is editing);
  `private` is your own copy, and uncommitted changes are dropped when the session ends.
- A lock left by a killed script blocks others until its session closes: use `with`.
- `RpcTimeoutError` on a commit does not mean it failed: check `show system commit`.
- Reply text can have extra spaces or newlines: use `normalize=True`.

## Testing with saved sample data
- Keep parsing apart from the device: a function that takes an lxml element.
- Tables read saved XML with no device: `LLDPNeighborTable(path="tests/data/lldp.xml").get()`.
  Record once with `tbl.savexml(path)` only with the user's OK on a lab device.
- Replace hostnames, serials, MACs and IPs (192.0.2.x) and mark the file
  "Sample data, not from a real network". In pytest, patch `jnpr.junos.Device`.
- `casper new junos-ansible`: `junipernetworks.junos` playbooks that only run `show`, plus
  `checks/render.yml` (`state: rendered`, no device). Casper's `junoser` and `yanglint`
  checks read config files offline; Junoser's grammar can lag new Junos releases.

## Public docs
- https://www.juniper.net/documentation/product/us/en/junos-pyez/
- https://github.com/Juniper/py-junos-eznc
- https://github.com/Juniper/ansible-junos-stdlib
