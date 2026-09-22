"""Casper-owned Codex login PTY acceptance with synthetic, localhost-free provider responses."""
import importlib.util
import json
import os
import pathlib
import re
import signal
import stat
import sys
import time

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("terminal_pty", pathlib.Path(__file__).with_name("terminal-pty.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
Session = module.Session


def wait_exit(s, timeout=5):
    deadline = time.monotonic() + timeout
    while s.process.poll() is None and time.monotonic() < deadline: s.pump(0.05)
    assert s.process.poll() == 0, s.screen.text()[-5000:]


def success(bun, repo, root, no_color):
    s = Session(bun, repo, root, no_color, app="src/cli.ts", preload="tests/fixtures/login-preload.ts",
                extra_env={"PI_OFFLINE": "1", "PI_TELEMETRY": "0"})
    try:
        s.until("/help · /status · /login")
        s.until("│ idle")
        draft = "d" * 95
        s.send("/login\n" + draft + "\x1b[D\x1b[D")
        s.until("Choose provider")
        s.until("Up/Down selects; Enter confirms")
        s.send("\n")
        s.until("Press Y to consent")
        auth = s.root / "home/.pi/agent/auth.json"
        assert not auth.exists(), "consent screen created auth storage"
        # Bracketed paste and unrelated text are ignored, not echoed or reused as consent.
        s.send("\x1b[200~PASTED_SYNTHETIC_SECRET\x1b[201~")
        s.pump(0.1)
        assert "PASTED_SYNTHETIC_SECRET" not in s.screen.text(), s.screen.text()
        assert not auth.exists(), "paste unexpectedly granted consent"
        s.send("Y")
        s.until("https://auth.openai.com/codex/device")
        s.until("ABCD-EFGH")
        s.send("discard-me")
        (s.root / "authorize").touch()
        s.until("Credential saved. Local auth refreshed")
        saved = json.loads(auth.read_text())
        assert not (s.root / "home/.pi/agent/sessions").exists(), "login created an agent session"
        assert set(saved) == {"openai-codex"}, saved.keys()
        assert saved["openai-codex"]["type"] == "oauth"
        assert stat.S_IMODE(auth.stat().st_mode) == 0o600, oct(auth.stat().st_mode)
        screen = s.screen.text()
        assert "synthetic-refresh" not in screen and "synthetic-code" not in screen
        s.send("Q")
        s.pump(0.1)
        assert "d" * 93 + "Qdd" in re.sub(r"\n {2}", "", s.screen.text()), s.screen.text()
        s.send("\x01\x0b\x1b[A")
        s.pump(0.1)
        assert re.search(r"❯ /login\s*\n\s*─", s.screen.text()), s.screen.text()
        s.send("\x01\x0b/exit\n")
        wait_exit(s)
        urls = (s.root / "login-fetches.txt").read_text().splitlines()
        assert urls == [
            "https://auth.openai.com/api/accounts/deviceauth/usercode",
            "https://auth.openai.com/api/accounts/deviceauth/token",
            "https://auth.openai.com/oauth/token",
        ], urls
        if no_color: assert not re.search(rb"\x1b\[[0-9;:]*m", s.raw), "NO_COLOR emitted SGR"
    finally:
        (s.root / "transcript.txt").write_bytes(s.raw)
        s.close()


def cancel_and_eof(bun, repo, root, eof=False):
    s = Session(bun, repo, root, app="src/cli.ts", preload="tests/fixtures/login-preload.ts", extra_env={"PI_OFFLINE": "1", "PI_TELEMETRY": "0"})
    try:
        s.until("/help · /status · /login")
        s.until("│ idle")
        s.send("/login openai-codex\n")
        s.until("Press Y to consent")
        s.send("\x04" if eof else "\x1b")
        if eof:
            wait_exit(s)
        else:
            s.until("Cancelled; no credential saved")
            s.send("/exit\n"); wait_exit(s)
        assert not (s.root / "home/.pi/agent/auth.json").exists()
        assert not (s.root / "login-fetches.txt").exists()
    finally: s.close()


def sigterm(bun, repo, root):
    s = Session(bun, repo, root, app="src/cli.ts", extra_env={"PI_OFFLINE": "1", "PI_TELEMETRY": "0"})
    try:
        s.until("/help · /status · /login")
        s.until("│ idle")
        s.send("/login openai-codex\n"); s.until("Press Y to consent")
        s.process.terminate()
        deadline = time.monotonic() + 5
        while s.process.poll() is None and time.monotonic() < deadline: s.pump(0.05)
        # Python reports direct POSIX termination as -SIGTERM; Bun's own spawn
        # harness separately asserts Casper's graceful shutdown exit code 143.
        assert s.process.poll() in (-signal.SIGTERM, 143), (s.process.poll(), s.screen.text()[-4000:])
        auth = s.root / "home/.pi/agent/auth.json"
        assert not auth.exists(), "SIGTERM before consent created auth state"
    finally: s.close()


def dumb(bun, repo, root):
    s = Session(bun, repo, root, term="dumb", app="src/cli.ts", preload="tests/fixtures/login-preload.ts", extra_env={"PI_OFFLINE": "1", "PI_TELEMETRY": "0"})
    try:
        s.until("/help · /status · /login")
        s.send("/login\n")
        s.until("requires an interactive Casper terminal")
        assert not (s.root / "home/.pi/agent/auth.json").exists()
        assert not (s.root / "login-fetches.txt").exists()
        assert b"\x1b[" not in s.raw
        s.send("/exit\n"); wait_exit(s)
    finally: s.close()


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, module.terminate)
    bun, root = sys.argv[1:]
    repo = pathlib.Path(__file__).resolve().parents[2]
    for no_color in (False, True):
        case = pathlib.Path(root) / ("plain" if no_color else "color"); case.mkdir(); success(bun, repo, str(case), no_color)
    for name, eof in (("cancel", False), ("eof", True)):
        case = pathlib.Path(root) / name; case.mkdir(); cancel_and_eof(bun, repo, str(case), eof)
    case = pathlib.Path(root) / "sigterm"; case.mkdir(); sigterm(bun, repo, str(case))
    case = pathlib.Path(root) / "dumb"; case.mkdir(); dumb(bun, repo, str(case))
    print("LOGIN PTY PASS: consent, device display, paste disposal, save, draft/history, cancel, EOF, SIGTERM, NO_COLOR and TERM=dumb")
