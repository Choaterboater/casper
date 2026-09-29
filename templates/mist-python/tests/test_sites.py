"""Tests against recorded answers in tests/cassettes (sample data, not from your org).

They never reach the network: pytest runs with --record-mode=none, so a call with no recorded
answer fails. To record your own, see README.md.
"""

import pytest

from {{module}}.sites import connect, format_rows, inventory, list_sites, main


@pytest.mark.vcr
def test_list_sites(mist_token: str, mist_org: str) -> None:
    sites = list_sites(connect(mist_token), mist_org)
    assert sorted(site["name"] for site in sites) == ["Branch 12", "HQ"]


@pytest.mark.vcr
def test_inventory_lists_devices_per_site(mist_token: str, mist_org: str) -> None:
    rows = inventory(connect(mist_token), mist_org)
    assert [(row["site"], row["name"], row["type"]) for row in rows] == [
        ("Branch 12", "br12-ap-01", "ap"),
        ("HQ", "hq-ap-lobby", "ap"),
        ("HQ", "hq-sw-core", "switch"),
    ]


def test_format_rows_lines_up_columns() -> None:
    text = format_rows([{"site": "HQ", "name": "ap1", "type": "ap", "model": "AP45", "mac": "m"}])
    assert text.splitlines() == ["site  name  type  model  mac", "HQ    ap1   ap    AP45   m"]


def test_main_needs_a_token(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["--org", "some-org"]) == 2
    assert "MIST_APITOKEN" in capsys.readouterr().err
