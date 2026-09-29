"""Checks that need no device: files parse, playbooks only use the modules listed here, command
tasks only run show commands, and checks/ playbooks only render. They say what the files contain;
they don't prove a playbook is safe on a device. Add a module to ALLOWED only after reading what
it does.
"""

import os
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
PLAYBOOKS = sorted((ROOT / "playbooks").glob("*.yml"))
CHECKS = sorted((ROOT / "checks").glob("*.yml"))

ALLOWED = {
    "junipernetworks.junos.junos_facts",
    "junipernetworks.junos.junos_command",
    "ansible.builtin.debug",
    "ansible.builtin.assert",
    "ansible.builtin.set_fact",
}
COMMAND_MODULES = {"junipernetworks.junos.junos_command"}
BUILTIN = "ansible.builtin."
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
    assert PLAYBOOKS and CHECKS


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


@pytest.mark.parametrize("path", CHECKS, ids=lambda p: p.name)
def test_checks_only_render(path: Path) -> None:
    for play in yaml.safe_load(path.read_text()):
        assert play["hosts"] == "localhost", f"{path.name}: checks run on this machine only"
        for task in tasks(play):
            module = module_of(task)
            if module is None or module.startswith(BUILTIN):
                continue
            assert task[module].get("state") == "rendered", f"{path.name}: {module} must render"


def test_inventory_is_the_lab_only() -> None:
    assert [p.name for p in (ROOT / "inventory").iterdir()] == ["lab.yml"]
    assert "inventory = inventory/lab.yml" in (ROOT / "ansible.cfg").read_text()


def test_no_password_in_the_inventory() -> None:
    hosts = yaml.safe_load((ROOT / "inventory" / "lab.yml").read_text())
    password = hosts["all"]["children"]["junos"]["vars"]["ansible_password"]
    assert password.startswith("{{ lookup('env',")


def test_render_check_runs() -> None:
    """Runs checks/render.yml once the collections are installed (see README.md)."""
    if not (ROOT / "collections" / "ansible_collections" / "junipernetworks").is_dir():
        pytest.skip("Install the collections first (README.md); then this renders config.")
    playbook = Path(sys.executable).parent / "ansible-playbook"
    env = {**os.environ, "ANSIBLE_CONFIG": str(ROOT / "ansible.cfg")}
    done = subprocess.run(
        [str(playbook), "checks/render.yml"],
        cwd=ROOT, env=env, capture_output=True, text=True, timeout=300, check=False,
    )
    assert done.returncode == 0, done.stdout[-2000:] + done.stderr[-2000:]
