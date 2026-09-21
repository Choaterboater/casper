"""Real terminal consent and shutdown around the production debugger commands."""
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


def case(bun, repo, root, ending):
    def setup(home, project):
        (project / "program.py").write_text("answer = 42\n")
        (project / ".casper/debug.json").write_text(json.dumps({"targets": {"example": {
            "command": bun, "args": [str(repo / "tests/fixtures/dap-adapter.ts")], "adapterID": "fixture", "program": "program.py"
        }}}))
    s = module.Session(bun, repo, str(root), no_color=True, app="src/cli.ts", setup=setup,
                       extra_env={"PI_OFFLINE": "1", "PI_TELEMETRY": "0"})
    debuggee = None
    try:
        s.until("│ idle")
        # Pretyped yes is a draft, not consent to the subsequent exact launch preview.
        s.send("/debug start example\nyes")
        s.until("Launch this exact debugger target? Type yes:")
        s.send("\n")
        s.until("Debugger launch denied")
        assert not (root / "project/adapter-started").exists()
        s.send("\x01\x0b/debug start example\n")
        # Wait for a second actual question, not the old transcript line.
        deadline = time.monotonic() + 5
        while s.raw.count(b"Launch this exact debugger target? Type yes:") < 2 and time.monotonic() < deadline: s.pump(0.03)
        assert s.raw.count(b"Launch this exact debugger target? Type yes:") >= 2
        s.send("yes\n")
        s.until('"state":"stopped"')
        debuggee = int((root / "project/debuggee-pid").read_text())
        adapter = int((root / "project/adapter-started").read_text())
        assert alive(debuggee) and alive(adapter), "missing positive process control"
        assert not (root / "home/.pi/agent/auth.json").exists(), "debugging initialized provider auth"
        if ending == "sigterm": s.process.terminate()
        elif ending == "eof": s.send("\x04")
        else: s.send("/debug stop\n"); s.until('"state":"closed"'); s.send("/exit\n")
        deadline = time.monotonic() + 5
        while s.process.poll() is None and time.monotonic() < deadline: s.pump(0.03)
        assert s.process.poll() in (0, 143, -signal.SIGTERM), (s.process.poll(), s.screen.text())
        assert not alive(debuggee), "debuggee survived shutdown"
        assert not alive(adapter), "adapter survived shutdown"
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
    print("DEBUG PTY PASS: fresh consent, stop, EOF, SIGTERM and owned-process cleanup")
