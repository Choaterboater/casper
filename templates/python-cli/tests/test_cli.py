import pytest

from {{module}}.cli import greeting, main


def test_greeting_names_who() -> None:
    assert greeting("team") == "Hello, team!"


def test_hello_prints_greeting(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["hello", "--who", "team"]) == 0
    assert capsys.readouterr().out == "Hello, team!\n"


def test_unknown_command_exits_with_usage_error() -> None:
    with pytest.raises(SystemExit) as stopped:
        main(["nope"])
    assert stopped.value.code == 2
