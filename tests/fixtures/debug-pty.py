"""A real terminal launch and shutdown around the production debugger commands."""
import importlib.util
import json
import os
import pathlib
import signal
import sys
import time

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("terminal_pty", pathlib.Path(__file__).with_name("terminal-pty.py"))
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)


def alive(pid):
    try: os.kill(pid, 0); return True
    except ProcessLookupError: return False


def gone(pid, timeout=10):
    deadline = time.monotonic() + timeout
    while alive(pid) and time.monotonic() < deadline: time.sleep(0.05)
    return not alive(pid)


def case(bun, repo, root, ending):
    def setup(home, project):
        (project / "program.py").write_text("answer = 42\n")
        (project / ".casper/debug.json").write_text(json.dumps({"targets": {"example": {
            "command": bun, "args": [str(repo / "tests/fixtures/dap-adapter.ts")], "adapterID": "fixture", "program": "program.py"
        }}}))
    s = module.Session(bun, repo, str(root), no_color=True, app="src/cli.ts", setup=setup,
                       extra_env={"CASPER_OFFLINE": "1", "PI_TELEMETRY": "0"})
    debuggee = None
    try:
        s.until("│ idle")
        # The typed command is the yes: a one-line notice, then the launch, with no box.
        s.send("/debug start example\r")
        s.until("[debug] Not sandboxed")
        s.until('"state":"stopped"')
        debuggee = int((root / "project/debuggee-pid").read_text())
        adapter = int((root / "project/adapter-started").read_text())
        assert alive(debuggee) and alive(adapter), "missing positive process control"
        assert not (root / "home/.pi/agent/auth.json").exists(), "debugging initialized provider auth"
        s.until_ready()
        if ending == "sigterm": s.process.terminate()
        elif ending == "eof": s.send("\x04")
        else: s.send("/debug stop\n"); s.until('"state":"closed"'); s.until_ready(); s.send("/exit\n")
        assert s.wait_exit() in (0, 143, -signal.SIGTERM), (s.process.poll(), s.screen.text())
        # A killed process stays visible to kill(pid, 0) until it is reaped, which a busy machine can delay.
        assert gone(debuggee), f"debuggee survived shutdown ({ending})\n" + s.screen.text()[-1500:]
        assert gone(adapter), f"adapter survived shutdown ({ending})"
    finally:
        s.close()
        if debuggee and alive(debuggee): os.killpg(debuggee, signal.SIGKILL)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, module.terminate)
    bun, root = sys.argv[1:]
    repo = pathlib.Path(__file__).resolve().parents[2]
    for ending in ("stop", "eof", "sigterm"):
        directory = pathlib.Path(root) / ending; directory.mkdir()
        case(bun, repo, directory, ending)
    print("DEBUG PTY PASS: launch as typed, stop, EOF, SIGTERM and owned-process cleanup")
