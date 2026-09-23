"""Production multi-provider login; synthetic credentials/transport only."""
import importlib.util
import json
import pathlib
import re
import signal
import sys
import time

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("login_pty", pathlib.Path(__file__).with_name("login-pty.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
Session = module.Session


def run_case(bun, repo, root, provider, browser=False, action="save", no_color=False):
    s = Session(bun, repo, str(root), no_color, app="src/cli.ts", preload="tests/fixtures/login-preload.ts",
                extra_env={"PI_OFFLINE": "1", "PI_TELEMETRY": "0"})
    try:
        s.until("│ idle")
        # Navigate the chooser rather than only testing direct commands.
        s.send("/login\n")
        s.until("Choose provider"); s.until("Up/Down: choose")
        index = ["openai-codex", "github-copilot", "anthropic", "openrouter"].index(provider)
        for _ in range(index): s.send("\x1b[B"); s.pump(0.03)
        s.send("\n")
        if provider == "anthropic":
            s.until("Choose sign-in method")
            if browser: s.send("\x1b[B"); s.pump(0.03)
            s.send("\n")
        s.until("Press Y to consent")
        auth = s.root / "home/.pi/agent/auth.json"
        assert not auth.exists()
        s.send("\x1b[200~Y\x1b[201~"); s.pump(0.05)
        assert not auth.exists(), "paste granted consent"
        s.send("Y")
        secret = "synthetic-private-manual-code" if browser else "synthetic-private-api-key"
        if provider != "github-copilot":
            s.until("Private authorization code" if browser else "Private API key")
            s.until("Private input: [empty]")
            # Split bracketed paste exercises the parser, not just a whole escape sequence.
            s.send("\x1b[20"); s.send("0~" + secret[:12]); s.send(secret[12:] + "\x1b[201~")
            s.pump(0.08)
            assert secret.encode() not in s.raw, "secret echoed to terminal"
            assert json.loads(auth.read_text()) == {}, "paste auto-submitted"
            if action == "cancel": s.send("\x1b")
            elif action == "eof": s.send("\x04")
            elif action == "sigterm": s.process.terminate()
            else: s.send("\n")
        if action in ("eof", "sigterm"):
            deadline = time.monotonic() + 5
            while s.process.poll() is None and time.monotonic() < deadline: s.pump(0.05)
            assert s.process.poll() in (0, -signal.SIGTERM, 143), s.screen.text()
            assert json.loads(auth.read_text()) == {}
            return
        if action == "cancel":
            s.until("credential save outcome unknown")
            assert json.loads(auth.read_text()) == {}
        else:
            s.until("Credential saved. Local auth refreshed")
            saved = json.loads(auth.read_text())
            assert list(saved) == [provider], saved.keys()
            assert saved[provider]["type"] == ("oauth" if browser or provider == "github-copilot" else "api_key")
            if not browser and provider != "github-copilot": assert saved[provider]["key"] == secret
        assert not (s.root / "home/.pi/agent/sessions").exists()
        s.send("\x1b[A"); s.pump(0.08)
        assert re.search(r"❯ /login\s*\n\s*─", s.screen.text()), s.screen.text()
        assert secret.encode() not in s.raw
        assert b"synthetic-anthropic-private-access" not in s.raw
        assert b"synthetic-copilot-private-access" not in s.raw
        if no_color: assert not re.search(rb"\x1b\[[0-9;:]*m", s.raw)
        s.send("\x01\x0b/exit\n"); module.wait_exit(s)
    finally:
        (s.root / "transcript.txt").write_bytes(s.raw)
        s.close()


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, module.module.terminate)
    bun, root = sys.argv[1:]
    repo = pathlib.Path(__file__).resolve().parents[2]
    cases = [("github-copilot", False, "save", False)]
    cases += [("anthropic", browser, "save", browser) for browser in (False, True)]
    cases += [("openrouter", False, "save", False)]
    for i, (provider, browser, action, no_color) in enumerate(cases):
        case = pathlib.Path(root) / str(i); case.mkdir()
        run_case(bun, repo, case, provider, browser, action, no_color)
    print("MULTI LOGIN PTY PASS: providers, methods, consent, hidden paste, history, cancellation, EOF and SIGTERM")
