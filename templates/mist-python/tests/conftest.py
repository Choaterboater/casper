import os

import pytest

# The sample org in tests/cassettes. Sample data, not from your org.
SAMPLE_ORG = "00000000-0000-0000-0000-00000000000a"
SETTINGS = ("MIST_APITOKEN", "MIST_HOST", "MIST_USER", "MIST_PASSWORD", "MIST_ORG_ID")

# Read once, before any test clears them: only used when you record on purpose.
_YOURS = {name: os.environ.get(name, "") for name in SETTINGS}


@pytest.fixture(autouse=True)
def no_real_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    """mistapi reads these from the environment; tests pass what they need themselves."""
    for name in SETTINGS:
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def mist_token(record_mode: str) -> str:
    """The sample token when replaying; your token only when you record (--record-mode)."""
    if record_mode == "none":
        return "sample-token"
    if not _YOURS["MIST_APITOKEN"]:
        pytest.skip("Recording needs MIST_APITOKEN (a read-only token).")
    return _YOURS["MIST_APITOKEN"]


@pytest.fixture
def mist_org(record_mode: str) -> str:
    if record_mode == "none":
        return SAMPLE_ORG
    if not _YOURS["MIST_ORG_ID"]:
        pytest.skip("Recording needs MIST_ORG_ID.")
    return _YOURS["MIST_ORG_ID"]


@pytest.fixture(scope="module")
def vcr_config() -> dict[str, object]:
    """Recorded answers never keep the token."""
    return {"filter_headers": ["authorization"]}
