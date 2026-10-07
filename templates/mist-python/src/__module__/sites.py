"""List the sites in a Mist org and the devices at each one. Read-only: GET calls only.

Settings (environment):
  MIST_APITOKEN   a Mist API token; use a read-only one
  MIST_HOST       the Mist API host (default api.mist.com)
  MIST_ORG_ID     the org to list (or pass --org)
"""

from __future__ import annotations

import argparse
import os
import sys
from typing import Any

import mistapi
from mistapi.api.v1.orgs import sites as org_sites
from mistapi.api.v1.sites import devices as site_devices


def connect(token: str, host: str = "api.mist.com") -> mistapi.APISession:
    """A mistapi session for one token. The token isn't checked here; the first call checks it."""
    session = mistapi.APISession(host=host, show_cli_notif=False, console_log_level=40)
    session.set_api_token(token, validate=False)
    return session


def list_sites(session: mistapi.APISession, org_id: str) -> list[dict[str, Any]]:
    response = org_sites.listOrgSites(session, org_id, limit=1000)
    if response.status_code != 200:
        raise RuntimeError(f"Mist answered {response.status_code} for the site list")
    return mistapi.get_all(session, response)


def list_devices(session: mistapi.APISession, site_id: str) -> list[dict[str, Any]]:
    response = site_devices.listSiteDevices(session, site_id, type="all", limit=1000)
    if response.status_code != 200:
        raise RuntimeError(f"Mist answered {response.status_code} for the device list")
    return mistapi.get_all(session, response)


def inventory(session: mistapi.APISession, org_id: str) -> list[dict[str, str]]:
    """One row per device: site, name, type, model, mac."""
    rows: list[dict[str, str]] = []
    for site in sorted(list_sites(session, org_id), key=lambda s: str(s.get("name", ""))):
        for device in list_devices(session, site["id"]):
            rows.append(
                {
                    "site": str(site.get("name", "")),
                    "name": str(device.get("name") or device.get("mac", "")),
                    "type": str(device.get("type", "")),
                    "model": str(device.get("model", "")),
                    "mac": str(device.get("mac", "")),
                }
            )
    return rows


def format_rows(rows: list[dict[str, str]]) -> str:
    columns = ["site", "name", "type", "model", "mac"]
    widths = {c: max([len(c), *(len(row[c]) for row in rows)]) for c in columns}
    lines = ["  ".join(c.ljust(widths[c]) for c in columns).rstrip()]
    lines += ["  ".join(row[c].ljust(widths[c]) for c in columns).rstrip() for row in rows]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="{{name}}",
        description="List Mist sites and devices.",
    )
    parser.add_argument("--org", default=os.environ.get("MIST_ORG_ID"), help="org id (MIST_ORG_ID)")
    args = parser.parse_args(argv)
    token = os.environ.get("MIST_APITOKEN", "").strip()
    if not token:
        print("Set MIST_APITOKEN to a read-only Mist API token.", file=sys.stderr)
        return 2
    if not args.org:
        print("Pass --org or set MIST_ORG_ID.", file=sys.stderr)
        return 2
    session = connect(token, os.environ.get("MIST_HOST", "api.mist.com"))
    print(format_rows(inventory(session, args.org)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
