---
name: network-aoscx-rest
description: >-
  How to use the AOS-CX switch REST API from Python, pyaoscx or Ansible: REST versions, login
  sessions, depth and selector, read calls first, checkpoints, testing with saved answers.
tags: [aos-cx, aoscx, pyaoscx, aruba cx]
casper-skill:
  platform: aoscx
  triggers:
    strong: ["aos cx", "aoscx", "arubaos cx", "pyaoscx", "aruba cx", "cx switch", "cx switches", "arubanetworks.aoscx"]
    weak: ["cx"]
  frameworks: [aoscx]
  version: 3
---
# AOS-CX switch REST API

## When to use
Code that talks to one AOS-CX switch over HTTPS: `requests`, `pyaoscx`, or the
`arubanetworks.aoscx` Ansible collection. Base URL: `https://<switch>/rest/v10.09/` (version in
the path). For fleet work through Central, use a Central skill.

## Sign-in and tokens
- User and password from the environment only: `AOSCX_HOST`, `AOSCX_USER`, `AOSCX_PASSWORD`
  (the names `casper new aoscx-ansible` uses). Never in code, output, logs or saved samples.
- Use a lab account with the least rights the task needs. Only the product's own access check
  decides what a login may do.
- Login is `POST /rest/v10.09/login` with form fields `username` and `password`; it sets a
  session cookie. Always end with `POST /rest/v10.09/logout` in a `finally`.
- Keep certificate checks on: `verify` = the switch's CA or cert file (`AOSCX_CA_BUNDLE`).
  The name you connect to must match the certificate.

```python
import os, sys, requests

def open_session():
    host, user = os.environ.get("AOSCX_HOST"), os.environ.get("AOSCX_USER")
    pw, ca = os.environ.get("AOSCX_PASSWORD"), os.environ.get("AOSCX_CA_BUNDLE")
    if not (host and user and pw and ca):
        sys.exit("Set AOSCX_HOST, AOSCX_USER, AOSCX_PASSWORD and AOSCX_CA_BUNDLE")
    base = f"https://{host}/rest/{os.environ.get('AOSCX_API_VERSION', 'v10.09')}"
    s = requests.Session()
    s.verify = ca
    r = s.post(f"{base}/login", data={"username": user, "password": pw}, timeout=(5, 30))
    if r.status_code != 200:
        sys.exit(f"Login failed ({r.status_code}): check version in the path, user, REST on")
    return s, base

def close_session(s, base):
    s.post(f"{base}/logout", timeout=(5, 30))  # logout frees the session slot
```

## Read first
- `GET /rest/v10.09/firmware`: `current_version` of the software.
- `GET /rest/v10.09/system?attributes=hostname,platform_name`
- `GET /rest/v10.09/system/interfaces?depth=2&attributes=name,admin_state,link_state`
- `GET /rest/v10.09/system/vlans?depth=2`
- `GET /rest/v10.09/fullconfigs/running-config` and `.../startup-config`: whole config as JSON.

Query options: `depth` (1 gives only names and URIs; higher gives more), `attributes` (a
comma list of fields), `selector` (`configuration`, `status`, `statistics` or `writable`).
Interface names go in the path URL-encoded: `1/1/1` is `1%2F1%2F1`.

```python
s, base = open_session()
try:
    r = s.get(f"{base}/system/interfaces", timeout=(5, 30),
              params={"depth": 2, "attributes": "name,admin_state,link_state"})
    r.raise_for_status()
    for name, port in r.json().items():
        print(name, port.get("admin_state"), port.get("link_state"))
finally:
    close_session(s, base)
```

## Changing things (Casper asks)
MCP: Casper's change box asks; don't ask again in chat. Else ask the user first; show the exact call.
Casper also asks before a shell command reaches a new host.
- REST changes go to the running config. First save a checkpoint (the undo copy), then GET
  the object with `selector=writable`, change only the fields you need, show the diff.
- `PUT` replaces the whole writable object: fields you leave out are reset. pyaoscx says PATCH
  is not supported by the API it targets; newer releases may differ: check the current docs.
- For a few CLI lines, `aoscx_config` over SSH is often simpler.
- Changes need `https-server rest access-mode read-write` on the switch.

WRITE: `PUT /rest/v10.09/fullconfigs/<checkpoint_name>?from=/rest/v10.09/fullconfigs/running-config` saves a checkpoint.
WRITE: undo: copy the checkpoint back (`from=` it, to `running-config`).

WRITE: order: CLI `checkpoint auto <minutes>` (rolls back unless confirmed), change, check, `checkpoint auto confirm`, then save to startup.

WRITE: `PUT /rest/v10.09/system/vlans/<vlan_id>` replaces one VLAN.

WRITE: `PUT /rest/v10.09/fullconfigs/startup-config?from=/rest/v10.09/fullconfigs/running-config` saves running to startup.

WRITE: any `POST` or `DELETE`, firmware upload, reboot.

Many switches: one test switch first, then one at a time; stop at the first error and say what changed where.

WRITE: on a factory-default switch, pyaoscx `Session.open()` also sets the admin login.

## Paging and rate limits
- No paging: a list call returns the whole table. Keep answers small with `depth`,
  `attributes` and `selector`; big tables (MAC, routes) are slow at high depth.
- On HTTP 429 or 503 wait, then retry with backoff. One session per switch.

## Common traps
- Session leaks: a login without logout holds a slot until it times out (new logins fail).
  Always log out in `finally`.
- Version mismatch: a REST version your firmware does not serve gives 404. pyaoscx 2.6.0 knows
  `10.04`, `10.08`, `10.09`; the Ansible collection defaults to `10.04`
  (`ansible_aoscx_rest_version`).
- Self-signed certs: never `verify=False`. pyaoscx turns certificate checks off inside its
  session: tell the user, and use it only on a trusted lab or management network.
- Newer releases send an `X-Csrf-Token` header at login when you ask with
  `x-use-csrf-token: true`; send it back on later calls (pyaoscx does). Check the current docs.
- REST must be on for the VRF you reach (`https-server vrf mgmt`), or you get a timeout.
- Do not trust `ansible-playbook --check` as a dry run on AOS-CX; read each module's docs.

## Testing with saved sample data
- `casper new aoscx-ansible`: playbooks that only run `show`, pytest checks with no switch.
  REST modules need `ansible_connection: arubanetworks.aoscx.aoscx`; add a module to the
  test's list only after reading what it does.
- Python: `responses` for `requests` (mock `login`, the GETs and `logout`), or
  `pytest-recording` with `--record-mode=none` and
  `vcr_config = {"filter_headers": ["cookie", "set-cookie", "x-csrf-token"]}`.
- Record once only with the user's OK on a lab switch. Replace hostnames, serials, MACs and IPs
  (192.0.2.x) and mark the file "Sample data, not from a real network".

## Public docs
- https://developer.arubanetworks.com/aruba-aoscx/docs/about-the-rest-api
- https://github.com/aruba/pyaoscx
- https://github.com/aruba/aoscx-ansible-collection
