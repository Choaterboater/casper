---
name: network-central-api
description: >-
  How to call the new HPE Aruba Networking Central REST API (GreenLake sign-in) from Python:
  tokens, base URL, read calls first, paging, rate limits, tests with saved answers.
tags: [aruba central, new central, pycentral, greenlake]
casper-skill:
  platform: central
  triggers:
    strong: ["aruba central", "aruba networking central", "new central", "central api", "pycentral", "newcentralbase", "greenlake", "hpe greenlake"]
    weak: ["central", "glp"]
    unless: ["classic central", "central classic"]
  frameworks: [central]
  version: 1
---
# HPE Aruba Networking Central (new Central) REST API

## When to use
New Central: the Central you reach through HPE GreenLake, with paths like
`network-monitoring/v1/...` and `network-config/...`. Classic Central (paths like
`monitoring/v2/aps`, `configuration/v2/groups`, customer id and refresh token) is a different
API: use the network-central-classic-api skill. If the user is not sure which one they have, ask.

## Sign-in and tokens
- Values come from environment variables only: `CENTRAL_BASE_URL`, `CENTRAL_TOKEN_URL`,
  `CENTRAL_CLIENT_ID`, `CENTRAL_CLIENT_SECRET`. Never put them in code, print them or save them.
- Give the API client the least rights the task needs. Only the product's own access check
  decides what a token may do.
- The token request is a POST sign-in (OAuth client credentials, HTTP basic auth) to the URL
  in `CENTRAL_TOKEN_URL`. pycentral 2.0a25 uses host `sso.common.cloud.hpe.com`, path
  `/as/token.oauth2`; check the current docs.
- Tokens expire (pycentral's docs say 2 hours for Central). On a 401, get a new token once and
  retry once. A second 401, or a 403: stop and tell the user (wrong keys, cluster or rights).

```python
import os, time, httpx

def get_token() -> str:  # sign-in POST
    r = httpx.post(os.environ["CENTRAL_TOKEN_URL"], data={"grant_type": "client_credentials"}, timeout=30,
                   auth=(os.environ["CENTRAL_CLIENT_ID"], os.environ["CENTRAL_CLIENT_SECRET"]))
    r.raise_for_status()
    return r.json()["access_token"]
```

## Read first
These calls ask for data. Run them first to learn the account:
- `GET network-monitoring/v1/devices` - devices Central monitors
- `GET network-monitoring/v1/sites` - sites and their health
- `GET network-config/v1alpha1/sites` - site list on the config side

The version part of a path (`v1`, `v1alpha1`) changes over time; check the current docs.

```python
def get_all(c: httpx.Client, path: str, limit: int = 100) -> list[dict]:
    items, nxt, tries = [], 1, 0
    while True:
        r = c.get(path, params={"limit": limit, "next": nxt})
        if r.status_code == 429 and tries < 5:
            tries += 1
            time.sleep(2 ** tries)
            continue
        if r.status_code >= 400:
            raise SystemExit(f"GET {path} failed: HTTP {r.status_code} {r.text[:200]}")
        body = r.json()
        items += body.get("items", [])
        nxt = body.get("next")
        if not nxt or len(items) >= body.get("total", len(items)):
            return items

base = os.environ["CENTRAL_BASE_URL"].rstrip("/")
with httpx.Client(base_url=base, timeout=httpx.Timeout(30, connect=10),
                  headers={"Authorization": f"Bearer {get_token()}"}) as c:
    print(len(get_all(c, "network-monitoring/v1/devices")), "devices")
```

With pycentral 2.x (a pre-release: `pip install --pre pycentral`), it gets and renews the token:

```python
from pycentral import NewCentralBase
conn = NewCentralBase(token_info={"new_central": {
    "base_url": os.environ["CENTRAL_BASE_URL"],
    "client_id": os.environ["CENTRAL_CLIENT_ID"],
    "client_secret": os.environ["CENTRAL_CLIENT_SECRET"]}})
resp = conn.command(api_method="GET", api_path="network-monitoring/v1/devices",
                    api_params={"limit": 100, "next": 1})
if resp["code"] != 200:
    raise SystemExit(f"Central said {resp['code']}: {resp['msg']}")
```

## Changing things (Casper asks)
Stop and ask the user before running anything in this section. Show the exact call first.
Casper also asks before a shell command reaches a new host.
- First GET the object and save the answer to a file. Show the body you will send and how it
  differs from what is there now.
- Say which scope the change hits. Config is set at a scope (global, site collection, site,
  device group, device), and a change at a higher scope reaches every device under it.
- WRITE: `POST network-config/v1alpha1/sites` makes a site.
- WRITE: `PUT network-config/v1alpha1/sites` replaces a site. Send the full object, not a part.
- WRITE: `DELETE` on any config object removes it.
- To undo: send the saved body back, and ask the user again before you do.

## Paging and rate limits
- Monitoring lists: `limit` plus `next`. The answer has `items`, `total` and `next`. Stop when
  `next` is empty or you have `total` items.
- Config lists (sites and scopes): `limit` plus `offset`.
- The largest `limit` differs per endpoint; check the current docs.
- Central has rate limits; check the current docs for the numbers. On HTTP 429
  wait, then retry a few times with a longer wait each time. Never retry in a tight loop.

## Common traps
- Wrong base URL: each cluster has its own API gateway URL. Copy it from Central, do not guess.
- A classic path (`monitoring/v2/aps`) on a new Central base URL gives 404.
- pycentral's `command()` does not raise on HTTP errors; check `resp["code"]`.
- Never turn off TLS checks (`verify=False`).
- Never log request headers or the token; keep debug logging off around the sign-in call.

## Testing with saved sample data
- Tests make no live calls. Use `respx` for httpx: return a saved answer for
  `GET {base}/network-monitoring/v1/devices` and patch `get_token` to return `"test-token"`.
- Or pytest-recording (vcrpy) with `--record-mode=none` and
  `vcr_config = {"filter_headers": ["authorization"]}`, as `casper new mist-python` does.
- Record once by hand, only with the user's OK. Before saving, replace tokens, IDs, hostnames,
  serials and MAC addresses with placeholders.
- Sample data, not from a real network:
  `{"items": [{"serialNumber": "SAMPLE0001", "deviceName": "ap-lab-1"}], "total": 1, "next": null}`

## Public docs
- https://developer.arubanetworks.com/new-central/docs/getting-started-with-rest-apis
- https://developer.arubanetworks.com/new-central/docs/generating-and-managing-access-tokens
- https://developer.arubanetworks.com/new-central/reference/
- https://github.com/aruba/pycentral
- https://pypi.org/project/pycentral/
