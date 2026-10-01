---
name: network-central-classic-api
description: >-
  How to call the classic HPE Aruba Networking Central API gateway from Python: access and
  refresh tokens, base URL, read calls first, offset paging, rate limits, tests with saved answers.
tags: [aruba central, classic central, pycentral, api gateway]
casper-skill:
  platform: central-classic
  triggers:
    strong: ["aruba central", "aruba networking central", "classic central", "central classic", "central api", "pycentral", "arubacentralbase", "apigw"]
    weak: ["central"]
    unless: ["new central"]
  frameworks: [central]
  version: 2
---
# HPE Aruba Networking Central (classic) API gateway

## When to use
Classic Central: paths like `monitoring/v2/aps` and `configuration/v2/groups`, an API gateway
base URL, a customer id, and access plus refresh tokens. New Central (GreenLake sign-in,
`network-monitoring/v1/...` paths) is a different API: use the network-central-api skill. If the
user is not sure which one they have, ask.

## Sign-in and tokens
- Values come from environment variables only: `CENTRAL_BASE_URL`, `CENTRAL_CLIENT_ID`,
  `CENTRAL_CLIENT_SECRET`, `CENTRAL_ACCESS_TOKEN`, `CENTRAL_REFRESH_TOKEN`. Never put them in code,
  never print them, never save them in samples.
- Make the token on Central's API Gateway page with the least rights the task needs. Only
  the product's own access check decides what a token may do.
- Access tokens expire (pycentral's docs say 2 hours). Refresh is a POST sign-in to
  `/oauth2/token` with `grant_type=refresh_token`. The answer holds a new access token and a new
  refresh token: keep the new one in a file outside the project (mode 600), never in git. How
  long a refresh token lasts: check the current docs.

```python
import os, time, httpx

BASE = os.environ["CENTRAL_BASE_URL"].rstrip("/")

def refresh(refresh_token: str) -> dict:  # sign-in POST
    r = httpx.post(f"{BASE}/oauth2/token", timeout=30, params={
        "client_id": os.environ["CENTRAL_CLIENT_ID"],
        "client_secret": os.environ["CENTRAL_CLIENT_SECRET"],
        "grant_type": "refresh_token", "refresh_token": refresh_token})
    r.raise_for_status()
    return r.json()  # access_token, refresh_token
```

## Read first
These calls ask for data. Run them first to learn the account:
- `GET /monitoring/v2/aps` (list key `aps`), `GET /monitoring/v1/switches` (`switches`),
  `GET /monitoring/v1/gateways` (`gateways`)
- `GET /configuration/v2/groups` - group names
- `GET /central/v2/sites` - sites
- `GET /platform/device_inventory/v1/devices` - inventory

```python
def get_all(c: httpx.Client, path: str, key: str, limit: int = 100) -> list[dict]:
    items, tries = [], 0
    while True:
        r = c.get(path, params={"offset": len(items), "limit": limit, "calculate_total": "true"})
        if r.status_code == 429 and tries < 5:
            tries += 1
            time.sleep(2 ** tries)
            continue
        if r.status_code >= 400:
            raise SystemExit(f"GET {path} failed: HTTP {r.status_code} {r.text[:200]}")
        body = r.json()
        page = body.get(key, [])
        items += page
        if not page or len(items) >= body.get("total", len(items)):
            return items

with httpx.Client(base_url=BASE, timeout=httpx.Timeout(30, connect=10),
                  headers={"Authorization": f"Bearer {os.environ['CENTRAL_ACCESS_TOKEN']}"}) as c:
    print(len(get_all(c, "/monitoring/v2/aps", "aps")), "APs")
```

With pycentral 2.x (in 1.x, import `ArubaCentralBase` from `pycentral.base`):

```python
from pycentral.classic.base import ArubaCentralBase
central = ArubaCentralBase(central_info={"base_url": BASE,
    "token": {"access_token": os.environ["CENTRAL_ACCESS_TOKEN"]}}, ssl_verify=True)
resp = central.command(apiMethod="GET", apiPath="/configuration/v2/groups",
                       apiParams={"limit": 20, "offset": 0})
if resp["code"] != 200:
    raise SystemExit(f"Central said {resp['code']}: {resp['msg']}")
```

## Changing things (Casper asks)
MCP: Casper's change box asks; don't ask again in chat. Else ask the user first; show the exact call.
Casper also asks before a shell command reaches a new host.
- First GET what you will change and save the answer to a file. Show the body you will send.
- Say what it reaches: config set on a group goes to every device in that group.
- WRITE: `POST /configuration/v1/devices/move` moves devices to another group. They take that
  group's config.
- WRITE: `POST /configuration/v2/groups` makes a group.
- WRITE: any `PUT`, `PATCH` or `DELETE` under `/configuration/` changes or removes config.
- To undo: send the saved config back, and ask the user again before you do.

## Paging and rate limits
- Lists use `offset` (items to skip) and `limit`. Add `calculate_total=true` to get `total`.
- The largest `limit` differs per endpoint (groups take small pages); check the current docs.
- Rate limits are per second and per day. Answers carry `X-RateLimit-Limit-day`,
  `X-RateLimit-Remaining-day` and `X-RateLimit-Remaining-second`. The numbers are in the current
  docs.
- On HTTP 429 wait and retry a few times with a longer wait. If the day limit is used up, stop
  and tell the user.

## Common traps
- Wrong base URL: each cluster has its own API gateway URL. Copy it from Central, do not guess.
- A new Central path (`network-monitoring/v1/devices`) on a classic base URL gives 404.
- Group vs device: a device-level setting or template variable can hide the group config.
- pycentral classic caches tokens in a `temp` folder by default; keep it out of git. It sets
  no request timeout and exits the program on a request error.
- pycentral's `command()` does not raise on HTTP errors; check `resp["code"]`.
- Never turn off TLS checks (`ssl_verify=False`, `verify=False`).

## Testing with saved sample data
- Tests make no live calls. Use `respx` for httpx (return a saved answer for
  `GET {BASE}/monitoring/v2/aps`), or `responses` for pycentral classic, which uses requests.
- Or pytest-recording (vcrpy) with `--record-mode=none` and
  `vcr_config = {"filter_headers": ["authorization"]}`, as `casper new mist-python` does.
- Record once by hand, only with the user's OK. Before saving, replace tokens, IDs, hostnames,
  serials and MAC addresses with placeholders.
- Sample data, not from a real network:
  `{"aps": [{"serial": "SAMPLE0001", "name": "ap-lab-1"}], "count": 1, "total": 1}`

## Public docs
- https://developer.arubanetworks.com/central/docs/api-oauth-access-token
- https://developer.arubanetworks.com/central/docs/api-gateway-creating-application-token
- https://developer.arubanetworks.com/central/docs/python-using-api-sdk
- https://github.com/aruba/pycentral
