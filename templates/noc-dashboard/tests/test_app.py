"""The page itself, run in memory with Streamlit's AppTest (no browser, no server, no network)."""

from pathlib import Path

import pytest
from streamlit.testing.v1 import AppTest

SRC = Path(__file__).resolve().parents[1] / "src"
APP = SRC / "{{module}}" / "app.py"


@pytest.fixture(autouse=True)
def sample_data(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("NOC_SOURCE", "MIST_APITOKEN", "MIST_HOST", "MIST_ORG_ID"):
        monkeypatch.delenv(name, raising=False)


def test_page_shows_sample_counts() -> None:
    page = AppTest.from_file(str(APP)).run(timeout=30)
    assert not page.exception
    assert page.title[0].value == "{{name}}"
    metrics = {metric.label: metric.value for metric in page.metric}
    assert metrics == {"Up": "2", "Down": "1", "Devices": "3"}
    assert "Sample data" in page.caption[0].value


def test_page_shows_the_problem_instead_of_crashing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("NOC_SOURCE", "central")
    page = AppTest.from_file(str(APP)).run(timeout=30)
    assert not page.exception
    assert "Central isn't built" in page.error[0].value
