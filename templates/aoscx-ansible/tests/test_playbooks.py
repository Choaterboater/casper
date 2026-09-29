"""Checks that need no switch and no network: files parse, playbooks only use the modules listed
here, and command tasks only run show commands. They say what the files contain; they don't
prove a playbook is safe on a device. Add a module to ALLOWED only after reading what it does.
"""

from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
PLAYBOOKS = sorted((ROOT / "playbooks").glob("*.yml"))

ALLOWED = {
    "arubanetworks.aoscx.aoscx_command",
    "ansible.builtin.debug",
    "ansible.builtin.assert",
    "ansible.builtin.set_fact",
}
COMMAND_MODULES = {"arubanetworks.aoscx.aoscx_command"}
TASK_KEYS = {
    "name", "register", "when", "loop", "tags", "vars", "changed_when", "failed_when",
    "ignore_errors", "no_log", "delegate_to", "run_once", "become", "check_mode", "diff",
}


def tasks(play: dict) -> list[dict]:
    found: list[dict] = []
    for key in ("pre_tasks", "tasks", "post_tasks", "handlers"):
        for task in play.get(key) or []:
            found.extend(task.get("block", []) + task.get("rescue", []) + task.get("always", []))
            found.append(task)
    return found


def module_of(task: dict) -> str | None:
    modules = [key for key in task if key not in TASK_KEYS | {"block", "rescue", "always"}]
    return modules[0] if modules else None


def test_there_are_playbooks() -> None:
    assert PLAYBOOKS


@pytest.mark.parametrize("path", PLAYBOOKS, ids=lambda p: p.name)
def test_playbooks_use_only_listed_modules(path: Path) -> None:
    for play in yaml.safe_load(path.read_text()):
        for task in tasks(play):
            module = module_of(task)
            if module is None:
                continue
            assert module in ALLOWED, f"{path.name}: {module} isn't in ALLOWED"
            assert "delegate_to" not in task, f"{path.name}: delegate_to reaches other hosts"


@pytest.mark.parametrize("path", PLAYBOOKS, ids=lambda p: p.name)
def test_command_tasks_only_show(path: Path) -> None:
    for play in yaml.safe_load(path.read_text()):
        for task in tasks(play):
            module = module_of(task)
            if module in COMMAND_MODULES:
                for command in task[module]["commands"]:
                    assert str(command).startswith("show "), f"{path.name}: {command}"


def test_inventory_is_the_lab_only() -> None:
    assert [p.name for p in (ROOT / "inventory").iterdir()] == ["lab.yml"]
    assert "inventory = inventory/lab.yml" in (ROOT / "ansible.cfg").read_text()


def test_no_password_in_the_inventory() -> None:
    hosts = yaml.safe_load((ROOT / "inventory" / "lab.yml").read_text())
    password = hosts["all"]["children"]["aoscx"]["vars"]["ansible_password"]
    assert password.startswith("{{ lookup('env',")
