---
name: network-mist-api
description: >-
  How to call the Juniper Mist cloud API from Python or curl: tokens, cloud hosts, org and site
  IDs, read calls first, paging, rate limits, testing with saved answers.
tags: [mist, juniper mist, mistapi]
casper-skill:
  platform: mist
  triggers:
    strong: ["mist api", "juniper mist", "mistapi", "api.mist.com", "mist org", "mist site", "mist webhook", "mist websocket"]
    weak: ["mist"]
  frameworks: [mist]
  version: 3
---
# Juniper Mist cloud API

## When to use
Code that talks to the Mist cloud (APs, switches and gateways managed by Mist), with the
`mistapi` Python package, `requests` or curl. For CLI or NETCONF on one Junos box, use the Junos
skill instead. Base URL: `https://<mist_host>/api/v1/`.

## Sign-in and tokens
- Token from the environment only: `MIST_APITOKEN` (the name `mistapi` and `casper new mist-python`
  use), host from `MIST_HOST`. Never put a token in code, output, logs or saved samples.
- Header: `Authorization: Token <token>`.
- The host is your org's cloud: `api.mist.com`, `api.eu.mist.com`, `api.gc1.mist.com`, and more.
  Use the host that matches the portal URL your org logs in to.
- User token: same rights as the admin who made it; the spec says it is removed after 90 days
  unused. Org token: one org only, with the role picked when it was made. Ask for the smallest
  role the task needs (an observer role for reports).
- Only the product's own access check decides what a token may do.
- Make tokens in the portal. Do not write code that makes tokens.

## Read first
These calls ask for data. Run them first to learn what the token sees.
- `GET /api/v1/self`: who you are; `privileges` lists org and site IDs and roles.
- `GET /api/v1/self/usage`: calls used in this hour and the limit.
- `GET /api/v1/orgs/<org_id>/sites`, `GET /api/v1/orgs/<org_id>/inventory`
- `GET /api/v1/sites/<site_id>/devices?type=all` (default type is `ap` only)
- `GET /api/v1/sites/<site_id>/stats/devices?type=all`: live status
- `GET /api/v1/sites/<site_id>/setting/derived`: site settings after templates
- 5 GHz/RF: `GET /api/v1/orgs/<org_id>/rftemplates` and
  `GET /api/v1/sites/<site_id>/stats/devices/<device_id>`.

```python
import os, sys, mistapi
from mistapi.api.v1.orgs import sites

token, org_id = os.environ.get("MIST_APITOKEN"), os.environ.get("MIST_ORG_ID")
if not token or not org_id:
    sys.exit("Set MIST_APITOKEN and MIST_ORG_ID")
host = os.environ.get("MIST_HOST", "api.mist.com")
s = mistapi.APISession(host=host, show_cli_notif=False, console_log_level=40)
s.set_api_token(token, validate=False)
r = sites.listOrgSites(s, org_id, limit=1000)
if r.status_code != 200:
    sys.exit(f"Mist answered {r.status_code}: check host, token and org id")
for site in mistapi.get_all(s, r):  # follows every page
    print(site["id"], site["name"])
```

Plain `requests`: always set `timeout=(5, 30)`, call `r.raise_for_status()`, keep
certificate checks on.

## Changing things (Casper asks)
MCP: Casper's change box asks; don't ask again in chat. Else ask the user first; show the exact call.
Casper also asks before a shell command reaches a new host.
- First GET the object, change only the fields you need, and show the user the diff of the
  body you will send. Check in the docs whether that call merges or replaces fields.
- Keep the GET answer as the undo copy.

WRITE: `PUT /api/v1/sites/<site_id>/devices/<device_id>` changes one device.

WRITE: `PUT /api/v1/sites/<site_id>/setting` changes site settings.

WRITE: `POST /api/v1/orgs/<org_id>/webhooks` adds a webhook.

WRITE: any `DELETE`, and device commands such as restart or upgrade.

WRITE: `DELETE /api/v1/self` deletes your own account: never run it.

- Templates (`/orgs/<org_id>/networktemplates`, `/templates` for WLANs, `/rftemplates`,
  `/gatewaytemplates`, `/sitetemplates`) change every site they are assigned to. Say how many
  sites that is before any change (GET the sites and count them).

WRITE: `POST /api/v1/sites/<site_id>/clients/<client_mac>/disconnect` kicks a client to re-join.

## Paging and rate limits
- List calls take `limit` and `page` (page starts at 1). The answer has headers `X-Page-Total`,
  `X-Page-Limit` and `X-Page-Page`: keep going until you have them all.
- Search calls (`.../search`) return a `next` URL in the body: follow it as given.
- `mistapi.get_all()` does both for you.
- Limit is per token, per hour. The public spec says 5000 calls per hour; check the current docs.
- On HTTP 429 wait (use `Retry-After` if sent), then retry with backoff. Loop over sites
  slowly. `mistapi` retries 429 a few times on its own.

## Common traps
- Wrong cloud host: the token gives 401 or 404 on another cloud. Match the portal URL.
- `org_id` and `site_id` are both UUIDs. Site calls are `/sites/<site_id>/...`, not under orgs.
- Device lists and stats return APs only unless you pass `type=all` (or `switch`, `gateway`).
- A token that can see one site gets 403 on org calls. Check `privileges` from `/self`.
- Webhooks: Mist sends events to your URL; set a `secret` and check the `X-Mist-Signature-v2`
  header as the docs describe. Websockets: `wss://<ws_host>/api-ws/v1/stream`, where
  `<ws_host>` is your API host with `api.` changed to `api-ws.`; send
  `{"subscribe": "/sites/<site_id>/stats/devices"}`.
- RF: `channels: null` = auto (RRM may pick DFS); 5 GHz `bandwidth` is 20/40/80, no auto;
  `full_automatic_rrm` is in an AP's `radio_config`, not the template.
- Stats replies run a KB+ per device and may ignore `fields`; page with `limit`/`page`.
- Never `verify=False`.

## Testing with saved sample data
- `casper new mist-python` makes a working project: pytest + `pytest-recording` with
  `--record-mode=none`, so a call with no saved answer fails instead of reaching Mist.
- Save answers with `vcr_config = {"filter_headers": ["authorization", "cookie"]}`.
- Record once only with the user's OK and a low-rights token. Before saving, replace real
  IDs, names, MACs, serials and IPs with sample values (`00000000-0000-0000-0000-000000000000`,
  192.0.2.x) and mark the file "Sample data, not from a real network".
- For plain `requests`, use `responses`; for `httpx`, `respx`.

## Public docs
- https://www.juniper.net/documentation/us/en/software/mist/api/http/getting-started/how-to-get-started
- https://www.juniper.net/documentation/us/en/software/mist/automation-integration/index.html
- https://github.com/mistsys/mist_openapi
- https://github.com/tmunzer/mistapi_python
- https://pypi.org/project/mistapi/
