"""Where the dashboard's data comes from. Read-only: GET calls only.

Settings (environment):
  NOC_SOURCE      fixtures | mist | central (default: mist when MIST_APITOKEN is set, else fixtures)
  MIST_APITOKEN   a Mist API token; use a read-only one
  MIST_HOST       the Mist API host (default api.mist.com)
  MIST_ORG_ID     the Mist org to show
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from importlib import resources
from typing import Any

SAMPLE_NOTE = "Sample data, not from your org. Set MIST_APITOKEN (read-only) and MIST_ORG_ID."


@dataclass
class Snapshot:
    source: str
    sites: list[dict[str, Any]]
    devices: list[dict[str, Any]]
    note: str = ""
    problems: list[str] = field(default_factory=list)


def chosen_source(env: dict[str, str] | None = None) -> str:
    env = dict(os.environ) if env is None else env
    wanted = env.get("NOC_SOURCE", "").strip().lower()
    if wanted in {"fixtures", "mist", "central"}:
        return wanted
    return "mist" if env.get("MIST_APITOKEN", "").strip() else "fixtures"


def load_fixtures() -> Snapshot:
    folder = resources.files(__package__).joinpath("fixtures")
    sites = json.loads(folder.joinpath("sites.json").read_text(encoding="utf-8"))
    devices = json.loads(folder.joinpath("devices.json").read_text(encoding="utf-8"))
    return Snapshot("fixtures", sites, devices, SAMPLE_NOTE)


def load_mist(env: dict[str, str]) -> Snapshot:
    import mistapi
    from mistapi.api.v1.orgs import sites as org_sites
    from mistapi.api.v1.orgs import stats as org_stats

    org_id = env.get("MIST_ORG_ID", "").strip()
    if not org_id:
        return Snapshot("mist", [], [], problems=["Set MIST_ORG_ID to the org to show."])
    session = mistapi.APISession(
        host=env.get("MIST_HOST", "api.mist.com"), show_cli_notif=False, console_log_level=40
    )
    session.set_api_token(env["MIST_APITOKEN"], validate=False)
    sites = mistapi.get_all(session, org_sites.listOrgSites(session, org_id, limit=1000))
    stats = org_stats.listOrgDevicesStats(session, org_id, type="all", limit=1000)
    devices = mistapi.get_all(session, stats)
    return Snapshot("mist", sites, devices, f"Mist org {org_id}")


def load_snapshot(env: dict[str, str] | None = None) -> Snapshot:
    env = dict(os.environ) if env is None else env
    source = chosen_source(env)
    if source == "central":
        return Snapshot(
            "central", [], [], problems=["Central isn't built into this dashboard yet. Use Mist."]
        )
    if source == "mist":
        if not env.get("MIST_APITOKEN", "").strip():
            return Snapshot("mist", [], [], problems=["Set MIST_APITOKEN to a read-only token."])
        return load_mist(env)
    return load_fixtures()


def summary(devices: list[dict[str, Any]]) -> dict[str, int]:
    up = sum(1 for d in devices if str(d.get("status", "")).lower() == "connected")
    return {"devices": len(devices), "up": up, "down": len(devices) - up}


def device_rows(snapshot: Snapshot) -> list[dict[str, str]]:
    names = {site.get("id"): str(site.get("name", "")) for site in snapshot.sites}
    rows = [
        {
            "site": names.get(device.get("site_id"), ""),
            "name": str(device.get("name") or device.get("mac", "")),
            "type": str(device.get("type", "")),
            "model": str(device.get("model", "")),
            "status": str(device.get("status", "unknown")),
        }
        for device in snapshot.devices
    ]
    return sorted(rows, key=lambda row: (row["status"] == "connected", row["site"], row["name"]))
