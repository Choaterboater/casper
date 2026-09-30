from {{module}}.data import (
    SAMPLE_NOTE,
    chosen_source,
    device_rows,
    load_fixtures,
    load_snapshot,
    summary,
)


def test_sample_data_without_a_token() -> None:
    assert chosen_source({}) == "fixtures"
    snapshot = load_snapshot({})
    assert snapshot.note == SAMPLE_NOTE
    assert len(snapshot.devices) == 3


def test_mist_when_a_token_is_set() -> None:
    assert chosen_source({"MIST_APITOKEN": "x"}) == "mist"


def test_mist_without_an_org_says_so() -> None:
    snapshot = load_snapshot({"NOC_SOURCE": "mist", "MIST_APITOKEN": "x"})
    assert snapshot.problems == ["Set MIST_ORG_ID to the org to show."]


def test_central_is_not_built_yet() -> None:
    snapshot = load_snapshot({"NOC_SOURCE": "central"})
    assert "Central isn't built" in snapshot.problems[0]


def test_summary_counts_up_and_down() -> None:
    assert summary(load_fixtures().devices) == {"devices": 3, "up": 2, "down": 1}


def test_down_devices_come_first() -> None:
    rows = device_rows(load_fixtures())
    assert rows[0] == {
        "site": "Branch 12",
        "name": "br12-ap-01",
        "type": "ap",
        "model": "AP34",
        "status": "disconnected",
    }
