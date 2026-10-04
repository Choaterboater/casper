import importlib

import pytest

# The module, not the MCPServer object the package also calls `server`.
server_module = importlib.import_module("{{module}}.server")


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture(autouse=True)
def sample_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    """Tests never use your real token or host. Sample data, not from your org."""
    monkeypatch.setenv("MIST_API_TOKEN", "sample-token")
    monkeypatch.setenv("MIST_HOST", "api.mist.com")
    monkeypatch.setattr(server_module, "READ_ONLY", False)


@pytest.fixture(scope="module")
def vcr_config() -> dict[str, object]:
    """For recorded tests: never save the token."""
    return {"filter_headers": ["authorization"]}
