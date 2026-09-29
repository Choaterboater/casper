"""Casper's hier_config report: the lines to change and the lines to undo them.

Usage: python hier_config_diff.py <aoscx|junos> <running file> <intended file>
Prints JSON {change_lines, undo_lines, remediation, rollback}.
Exit 3: hier_config is not installed. Exit 2: bad arguments or unreadable files.
hier_config (MIT, netdevops) is imported from the project's Python; Casper
never installs it. Its Junos driver is marked experimental upstream.
"""

import json
import sys

try:
    from hier_config import Platform, WorkflowRemediation, get_hconfig
except Exception:  # noqa: BLE001 - any import problem means "not installed"
    sys.exit(3)

PLATFORMS = {"aoscx": "ARUBA_AOSCX", "junos": "JUNIPER_JUNOS"}


def lines_of(config):
    dump = getattr(config, "dump_simple", None)
    if callable(dump):
        return [str(line) for line in dump() if str(line).strip()]
    return [line for line in str(config).splitlines() if line.strip()]


def main(argv):
    if len(argv) != 4 or argv[1] not in PLATFORMS:
        print("usage: hier_config_diff.py <aoscx|junos> <running> <intended>", file=sys.stderr)
        return 2
    platform = getattr(Platform, PLATFORMS[argv[1]], None)
    if platform is None:
        print(f"this hier_config has no {PLATFORMS[argv[1]]} driver", file=sys.stderr)
        return 3
    try:
        with open(argv[2], encoding="utf-8") as handle:
            running_text = handle.read()
        with open(argv[3], encoding="utf-8") as handle:
            intended_text = handle.read()
    except OSError as error:
        print(f"cannot read a config file: {error}", file=sys.stderr)
        return 2
    workflow = WorkflowRemediation(get_hconfig(platform, running_text), get_hconfig(platform, intended_text))
    remediation = lines_of(workflow.remediation_config)
    rollback = lines_of(workflow.rollback_config)
    print(json.dumps({
        "change_lines": len(remediation),
        "undo_lines": len(rollback),
        "remediation": "\n".join(remediation),
        "rollback": "\n".join(rollback),
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
