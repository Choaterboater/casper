---
name: network-clearpass-api
description: >-
  How to call the ClearPass Policy Manager REST API from Python or pyclearpass: API clients,
  OAuth tokens, read calls first, paging, traps, testing with saved answers.
tags: [clearpass, cppm, pyclearpass]
casper-skill:
  platform: clearpass
  triggers:
    strong: ["clearpass", "pyclearpass", "cppm", "clearpass api", "clearpass policy manager"]
    weak: []
  frameworks: [clearpass]
  version: 2
---
# ClearPass Policy Manager REST API

## When to use
Code that talks to a ClearPass server over HTTPS with `requests` or `pyclearpass`: endpoints,
guest accounts, active sessions, server info. Base URL: `https://<clearpass>/api`. For the
switch or AP side, use the AOS-CX, Central or Mist skill.

## Sign-in and tokens
- An admin makes an API client in ClearPass Guest (API Services; check the current docs for
  the menu): client id, grant type `client_credentials`, an operator profile, a token lifetime.
- Id and secret from the environment only: `CLEARPASS_HOST`, `CLEARPASS_CLIENT_ID`,
  `CLEARPASS_CLIENT_SECRET`, `CLEARPASS_CA_BUNDLE`. Never in code, output, logs or saved samples.
- The operator profile sets the rights. Ask for the smallest one the task needs. Only the
  product's own access check decides what a token may do.
- Token: POST `/api/oauth` with JSON `grant_type`, `client_id`, `client_secret`; the answer has
  `access_token` and `expires_in`. Then send `Authorization: Bearer <token>`.

```python
import os, sys, requests

def open_session():
    env = {k: os.environ.get(k) for k in ("CLEARPASS_HOST", "CLEARPASS_CLIENT_ID",
                                          "CLEARPASS_CLIENT_SECRET", "CLEARPASS_CA_BUNDLE")}
    if not all(env.values()):
        sys.exit("Set " + ", ".join(env))
    base = f"https://{env['CLEARPASS_HOST']}/api"
    s = requests.Session()
    s.verify = env["CLEARPASS_CA_BUNDLE"]
    r = s.post(f"{base}/oauth", timeout=(5, 30), json={
        "grant_type": "client_credentials",
        "client_id": env["CLEARPASS_CLIENT_ID"],
        "client_secret": env["CLEARPASS_CLIENT_SECRET"]})
    if r.status_code != 200:
        sys.exit(f"Token request failed ({r.status_code}): check client id, grant type")
    s.headers["Authorization"] = "Bearer " + r.json()["access_token"]
    return s, base
```

## Read first
These calls ask for data. Run them first to learn the server and what the token may do.
- `GET /api/oauth/me` and `GET /api/oauth/privileges`: who you are, which rights you have.
- `GET /api/server/version` and `GET /api/cluster/server`: version and cluster members.
- `GET /api/endpoint?limit=25&calculate_count=true`: endpoints (MAC, status, attributes).
- `GET /api/endpoint/mac-address/<mac>`: one endpoint.
- `GET /api/session`: active sessions. `GET /api/guest`: guest accounts.
- `GET /api/insight/endpoint/mac/<mac>`: Insight data for one device.

Lists come back as `{"_embedded": {"items": [...]}}`; `count` is there only with
`calculate_count=true`.

```python
import json
s, base = open_session()
offset, limit = 0, 500
while True:
    r = s.get(f"{base}/endpoint", timeout=(5, 60), params={
        "offset": offset, "limit": limit, "filter": json.dumps({"status": "Known"})})
    if r.status_code in (401, 403):
        sys.exit(f"{r.status_code}: token expired or operator profile lacks this right")
    r.raise_for_status()
    items = r.json().get("_embedded", {}).get("items", [])
    for ep in items:
        print(ep.get("mac_address"), ep.get("status"))
    if len(items) < limit:
        break
    offset += limit
```

With pyclearpass: `ApiIdentities.get_endpoint(login, offset="0", limit="500")`.

## Changing things (Casper asks)
MCP: Casper's change box asks; don't ask again in chat. Else ask the user first; show the exact call.
Casper also asks before a shell command reaches a new host.
- First GET the object, change only the fields you need, show the diff of the body.
- Changes can reach users at once: with `change_of_authorization=true` (or the server's
  default) ClearPass sends CoA or Disconnect to the switch or AP.
- Undo: save the GET answer first, and put back the old values from it.

WRITE: `POST /api/endpoint` adds an endpoint (`mac_address`, `status` needed).

WRITE: `PATCH /api/endpoint/<endpoint_id>` changes some fields; `PUT` replaces the whole object.

WRITE: `POST /api/guest`, `PATCH /api/guest/<guest_id>` create or change a guest account.

WRITE: any `DELETE`, anything under `/api/session-action/` or `/api/session/<id>/disconnect`
(kicks users off), service start or stop, certificate changes.

## Paging and rate limits
- Paging: `offset` (from 0), `limit` (1 to 1000; pyclearpass says 25 by default), `sort`
  (for example `+id`), `filter` (a JSON object). Loop until a page is short.
- `calculate_count=true` adds `count` but can make the call slower on big tables; use it once.
- Rate limits: check the current docs. On HTTP 429 or 503 wait, then retry with backoff.

## Common traps
- Self-signed certs: never `verify=False`. Point `verify` at the server's CA file. The
  pyclearpass README examples use `verify_ssl=False`; do not copy that, and note that
  importing pyclearpass turns off urllib3 certificate warnings.
- pyclearpass returns the JSON of an error answer instead of raising: check the result has
  `_embedded` (or the fields you need) before you use it.
- 403 with a good token means the operator profile lacks the right; fix the profile, not the code.
- Tokens expire (lifetime is set on the API client). On 401, get a new token once, then stop.
- MAC formats differ between calls (`aa:bb:..`, `aa-bb-..`, `aabb..`): normalise before
  compare.
- Authentication records (Access Tracker): check the current docs for which API gives them.

## Testing with saved sample data
- `responses` for `requests`: mock `/api/oauth`, the GETs and a short last page.
- Or `pytest-recording` with `--record-mode=none` and
  `vcr_config = {"filter_headers": ["authorization", "cookie"]}`; also remove
  `access_token` from the saved token answer.
- Record once only with the user's OK on a lab server. Replace hostnames, MACs, usernames and
  IPs (192.0.2.x) and mark the file "Sample data, not from a real network".

## Public docs
- https://developer.arubanetworks.com/aruba-cppm/docs/clearpass-configuration
- https://developer.arubanetworks.com/aruba-cppm/docs/getting-started-with-pyclearpass
- https://github.com/aruba/pyclearpass
- https://pypi.org/project/pyclearpass/
