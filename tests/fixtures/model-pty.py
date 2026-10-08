"""Production Casper CLI + Casper model browser, local catalogs only; no model requests."""
import importlib.util
import json
import pathlib
import re
import signal
import sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("terminal_pty", pathlib.Path(__file__).with_name("terminal-pty.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
Session = module.Session


def exercise(bun, repo, root, no_color=False):
    s = Session(bun, repo, root, no_color, app="src/cli.ts", extra_env={"CASPER_OFFLINE": "1", "PI_TELEMETRY": "0"})
    agent = s.root / "home/.pi/agent"
    agent.mkdir(parents=True)
    (agent / "models.json").write_text(json.dumps({"providers": {"fixture": {
        "api": "openai-completions", "baseUrl": "http://127.0.0.1:9/v1", "apiKey": "fixture-not-a-secret",
        "models": [{"id": "first"}, {"id": "second"}]
    }}}))
    shared = '{"defaultProvider":"fixture","defaultModel":"first"}\n'
    (agent / "settings.json").write_text(shared)
    (agent / "auth.json").write_text("{}\n")
    try:
        s.until("/help · /status · /login")
        s.until("│ idle")  # Wait for the raw editor, not just the startup banner.
        draft = "x" * 95
        s.send("/model\n" + draft + "\x1b[D\x1b[D")
        s.until("remember globally")
        s.send("second")
        s.until("second · fixture/second")
        s.send("\x13")  # Ctrl+S is the explicit session-only alternative.
        s.until("Selected for this conversation only")
        assert not (s.root / "home/.casper/settings.json").exists()
        s.send("Q")
        s.until_true(lambda text: "x" * 93 + "Qxx" in re.sub(r"\n {2}", "", text))
        # The exclusive handoff must retain editor history as well as its draft.
        s.send("\x01\x0b\x1b[A")
        s.until_true(lambda text: re.search(r"❯ /model\s*\n\s*─", text) is not None)
        # Direct exact match, then search-prefilled picker and explicit save.
        s.until_ready()
        s.send("\x01\x0b/model fixture/first\n")
        s.until("model     fixture/first")
        s.until_ready()
        s.send("/model sec\n")
        s.until("second · fixture/second")
        s.send("\n")  # Normal selection now remembers the default.
        s.until("Selected and saved as the Casper default")
        s.until_ready()
        saved = json.loads((s.root / "home/.casper/settings.json").read_text())
        assert saved == {"defaultProvider": "fixture", "defaultModel": "second", "defaultThinkingLevel": "off", "modelThinkingLevels": {"fixture/first": "off", "fixture/second": "off"}}, saved
        s.send("/effort\n")
        s.until("Reasoning effort")
        s.send("\n")
        s.pump(0.2)
        assert json.loads((s.root / "home/.casper/settings.json").read_text())["defaultThinkingLevel"] == "off"
        s.until_ready()
        # Escape and Ctrl-C cancel the picker without changing model/default. A partial id opens the picker on it;
        # an id no model matches is an error line and never reaches the picker.
        for cancel in ("\x1b", "\x03"):
            s.send("/model fir\n")
            s.until_new("> fir")  # The picker's search line holds the id.
            s.send(cancel)
            s.until_ready()
            s.send("/status\n")
            # The first pass left the same line on screen: wait for this pass's.
            s.until_new("selection conversation · Casper default fixture/second")
            s.until_ready()
        assert (agent / "settings.json").read_text() == shared
        assert (agent / "auth.json").read_text() == "{}\n"
        assert "[error]" not in s.screen.text(), s.screen.text()
        s.send("/exit\n")
        assert s.wait_exit() == 0, s.screen.text()[-4000:]
        if no_color:
            assert not re.search(rb"\x1b\[(?:[0-9:]*;)*(?:3[0-9]|4[0-9]|9[0-7]|10[0-7])(?:[;:][0-9;:]*)?m", s.raw), "NO_COLOR emitted colour SGR"
    finally:
        (s.root / "transcript.txt").write_bytes(s.raw)
        s.close()


def exercise_saved_snapshot(bun, repo, root):
    def setup(home, project):
        (home / ".casper").mkdir(exist_ok=True)
        (home / ".casper/settings.json").write_text(json.dumps({"defaultProvider": "fixture", "defaultModel": "second", "defaultThinkingLevel": "high"}))
    s = Session(bun, repo, root, app="src/cli.ts", setup=setup, extra_env={"CASPER_OFFLINE": "1", "PI_TELEMETRY": "0"})
    try:
        s.until("default fixture/second")
        assert "high" in s.screen.text(), s.screen.text()
        assert not (s.root / "home/.pi/agent/auth.json").exists(), "footer snapshot initialized auth"
        # Enter before Casper reads commands keeps /exit as a draft: wait until it is idle.
        s.until("idle")
        s.send("/exit\n")
        assert s.wait_exit() == 0
    finally: s.close()


def exercise_empty_eof(bun, repo, root):
    s = Session(bun, repo, root, app="src/cli.ts", extra_env={"CASPER_OFFLINE": "1", "PI_TELEMETRY": "0"})
    try:
        s.until("/help · /status · /login")
        s.until("│ idle")
        s.send("hello\n")
        # With no model, Casper opens sign-in itself instead of printing a fake failed receipt.
        s.until("No model yet. Sign in to a provider to start")
        s.until("Type a number")
        s.send("\x1b")
        s.until("[login] Cancelled; no credential saved.")
        s.until("[model] No Casper model selected")
        s.pump(0.2)
        assert "model run failed" not in s.screen.text(), s.screen.text()
        assert s.screen.text().count("[model] No Casper model selected") == 1, s.screen.text()
        # With nothing signed in, /model opens sign-in instead of an empty picker.
        s.send("/model\n")
        s.until("Not signed in yet")
        s.until("Type a number")
        s.send("\x04")
        assert s.wait_exit() == 0, "EOF in picker did not exit: " + s.screen.text()[-4000:]
        assert not (s.root / "home/.casper/settings.json").exists()
    finally: s.close()


def exercise_dumb(bun, repo, root):
    s = Session(bun, repo, root, term="dumb", app="src/cli.ts", extra_env={"CASPER_OFFLINE": "1", "PI_TELEMETRY": "0"})
    try:
        s.until("/help · /status · /login")
        s.send("/model\n")
        s.until("No models with configured credentials")
        assert "to set as default" not in s.screen.text(), s.screen.text()
        assert b"\x1b[" not in s.raw, "TERM=dumb emitted terminal controls"
        s.send("/exit\n")
        assert s.wait_exit() == 0, s.screen.text()
    finally: s.close()


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, module.terminate)
    bun, root = sys.argv[1:]
    repo = pathlib.Path(__file__).resolve().parents[2]
    for no_color in (False, True):
        case = pathlib.Path(root) / ("plain" if no_color else "color")
        case.mkdir()
        exercise(bun, repo, str(case), no_color)
    snapshot = pathlib.Path(root) / "saved-snapshot"; snapshot.mkdir()
    exercise_saved_snapshot(bun, repo, str(snapshot))
    eof = pathlib.Path(root) / "empty-eof"
    eof.mkdir()
    exercise_empty_eof(bun, repo, str(eof))
    dumb = pathlib.Path(root) / "dumb"
    dumb.mkdir()
    exercise_dumb(bun, repo, str(dumb))
    print("MODEL PTY PASS: Model browser search, conversation selection, explicit default, cancel, draft/history, EOF, NO_COLOR, TERM=dumb and Pi settings/auth preservation")
