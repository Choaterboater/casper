"""Local-only PTY acceptance. Minimal VT screen tracks the sequences readline emits."""
import codecs
import errno
import fcntl
import json
import os
import pathlib
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time

class Screen:
    def __init__(self, width=80):
        self.width = width
        self.rows = [[]]
        self.x = self.y = 0
        self.pending = ""

    def feed(self, text):
        self.pending += text
        while self.pending:
            if self.pending.startswith("\x1b]8;"):
                match = re.match(r"\x1b\]8;.*?(?:\x07|\x1b\\)", self.pending, re.S)
                if not match: break
                self.pending = self.pending[match.end():]
                continue
            if self.pending.startswith("\x1b"):
                match = re.match(r"\x1b\[([0-9;?]*)([A-Za-z~])", self.pending)
                if not match:
                    if len(self.pending) < 24:
                        break
                    raise AssertionError("Unhandled terminal escape: " + repr(self.pending[:24]))
                args, cmd = match.groups()
                self.pending = self.pending[match.end():]
                n = int(args or "1") if ";" not in args and "?" not in args else 1
                if cmd == "A": self.y = max(0, self.y - n)
                elif cmd == "B": self.y += n
                elif cmd == "C": self.x += n
                elif cmd == "D": self.x = max(0, self.x - n)
                elif cmd == "G": self.x = n - 1
                elif cmd in ("H", "f"):
                    pos = [int(v or "1") for v in args.split(";")]
                    self.y, self.x = pos[0] - 1, (pos[1] if len(pos) > 1 else 1) - 1
                elif cmd == "J":
                    self.ensure(); self.rows[self.y] = self.rows[self.y][:self.x]; self.rows = self.rows[:self.y + 1]
                elif cmd == "K":
                    self.ensure()
                    if args == "2": self.rows[self.y] = []
                    else: self.rows[self.y] = self.rows[self.y][:self.x]
                continue
            char, self.pending = self.pending[0], self.pending[1:]
            if char == "\r": self.x = 0
            elif char == "\n": self.y += 1; self.ensure()
            elif char == "\b": self.x = max(0, self.x - 1)
            elif ord(char) >= 32:
                if self.x >= self.width: self.x = 0; self.y += 1
                self.ensure()
                row = self.rows[self.y]
                while len(row) <= self.x: row.append(" ")
                row[self.x] = char; self.x += 1

    def ensure(self):
        while len(self.rows) <= self.y: self.rows.append([])

    def text(self): return "\n".join("".join(row).rstrip() for row in self.rows)

class Session:
    def __init__(self, bun, repo, root, no_color=False, term="xterm-256color", app=None, extra_env=None, preload=None, setup=None):
        self.root = pathlib.Path(root)
        home = self.root / "home"; home.mkdir()
        project = self.root / "project"; (project / ".casper").mkdir(parents=True)
        (project / ".casper/mcp.json").write_text(json.dumps({"mcpServers": {"fixture": {
            "command": bun, "args": [str(repo / "tests/fixtures/mcp-server.ts")]
        }}}))
        if setup: setup(home, project)
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 100, 80, 0, 0))
        env = {"HOME": str(home), "PATH": os.environ["PATH"], "TERM": term, "CASPER_TTY_CONTROL": root}
        if no_color: env["NO_COLOR"] = "1"
        if extra_env: env.update(extra_env)
        command = [bun]
        if preload: command += ["--preload", str(repo / preload)]
        command += [str(repo / (app or "tests/fixtures/terminal-app.ts"))]
        self.process = subprocess.Popen(command, cwd=project,
                                        env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        self.screen = Screen()
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self.raw = b""

    def pump(self, duration=0.1):
        deadline = time.monotonic() + duration
        while time.monotonic() < deadline:
            if select.select([self.master], [], [], max(0, deadline - time.monotonic()))[0]:
                try: data = os.read(self.master, 65536)
                except OSError as error:
                    if error.errno == errno.EIO: return
                    raise
                if not data: return
                self.raw += data
                self.screen.feed(self.decoder.decode(data))

    def until(self, text, timeout=15):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.pump(0.03)
            if text in self.screen.text(): return
        raise AssertionError("Missing screen text: " + repr(text) + "\nSCREEN:\n" + self.screen.text()[-6000:])

    # A physical Enter sends CR in raw mode; LF is Ctrl+J (multiline input).
    def send(self, text): os.write(self.master, text.replace("\n", "\r").encode())
    def release(self, name): (self.root / name).touch()
    def requests(self):
        file = self.root / "requests.jsonl"
        return [json.loads(line) for line in file.read_text().splitlines()] if file.exists() else []
    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            try: self.process.wait(timeout=3)
            except subprocess.TimeoutExpired: self.process.kill(); self.process.wait()
        os.close(self.master)


def exercise(bun, repo, root, no_color):
    s = Session(bun, repo, root, no_color)
    try:
        s.until("/help · /status · /login")
        s.until("❯")
        startup = s.screen.text()
        assert "mcp       " not in startup and "visualize " not in startup and "indexed" not in startup
        s.send("stream\n")
        s.until("First bold and code")
        assert "[model] scripted/terminal-fixture" in s.screen.text()
        s.send("/sta")
        s.pump()
        assert "… /sta" in s.screen.text(), s.screen.text()
        s.release("stream-step")
        s.until("read · src/example.ts — running")
        assert "… /sta" in s.screen.text(), s.screen.text()
        assert "First bold and code text." in s.screen.text(), s.screen.text()
        s.send("tus\n")  # Enter during work must NOT queue or discard the draft.
        s.until("draft retained")
        assert s.requests() == ["stream"]
        s.release("stream-end")
        s.until("Done streaming.")
        s.until("❯ /status")
        assert s.requests() == ["stream"]
        s.send("\n")
        s.until("credentials configured (not a connection test)")
        s.until("mcp       1 configured")
        assert s.requests() == ["stream"]
        # Hidden streaming (reasoning, tool arguments) shows a live line that leaves no trace.
        s.send("progress\n")
        s.until("… thinking · 1.5k chars")
        s.release("progress-step")
        s.until("… write · composing arguments · 4.0k chars")
        assert "thinking · 1.5k" not in s.screen.text(), s.screen.text()
        s.release("progress-end")
        s.until("Written.")
        assert "composing arguments" not in s.screen.text(), s.screen.text()
        assert "✓ write · site/index.html — completed" in s.screen.text(), s.screen.text()
        # A wrapped draft with the cursor in its middle must survive activity.
        s.send("hold\n")
        s.until("Waiting for cancellation.")
        draft = "x" * 95
        s.send(draft + "\x1b[D\x1b[D")
        s.pump()
        s.send("\x03")
        s.until("Cancelling active work")
        s.until("Execution cancelled")
        s.send("Q\n")
        s.until("Echo:")  # Pi wraps an overlong word after the label; exact draft checked below.
        assert s.requests()[-1] == "x" * 93 + "Qxx", s.requests()
        # Clear separation between a pretyped draft and an exact confirmation.
        s.send("/mcp connect fixture\n")
        s.until("340 tools")
        s.send("approval-deny\n")
        s.until("Preparing approval.")
        s.send("yes")
        s.pump()
        s.release("approval-deny")
        s.until("Allow this exact external call? Type yes:")
        assert not s.screen.text().rstrip().endswith("Type yes: yes"), s.screen.text()
        s.send("\n")  # Empty fresh answer denies, despite the old 'yes' draft.
        s.until("Approval result: denied")
        s.until("❯ yes")
        assert s.requests()[-1] == "approval-deny"
        s.send("\x01\x0bapproval-allow\n")
        s.pump()
        s.release("approval-allow")
        s.until("Allow this exact external call? Type yes:")
        s.send("yes\n")
        s.until("Approval result: allowed")
        s.send("approval-cancel\n")
        s.pump()
        s.release("approval-cancel")
        s.until("Allow this exact external call? Type yes:")
        s.send("\x03")
        s.until("Execution cancelled")
        s.pump()
        assert len((s.root / "approvals.jsonl").read_text().splitlines()) == 3
        s.send("/login\n")
        s.until("This runtime does not support login")
        assert not any(request.startswith("/") for request in s.requests())
        before = s.requests()
        s.send("hold\n\x03")
        s.until("Request cancelled before startup")
        assert s.requests() == before
        s.send("/exit\n")
        deadline = time.monotonic() + 5
        while s.process.poll() is None and time.monotonic() < deadline: s.pump(0.05)
        assert s.process.poll() == 0, "Exit did not finish:\n" + s.screen.text()[-2000:]
        has_color = bool(re.search(rb"\x1b\[(?:1;36|32|33|36)m", s.raw))
        assert has_color != no_color, "color/NO_COLOR policy failed"
    finally:
        (s.root / "transcript.txt").write_bytes(s.raw)
        s.close()

def exercise_eof(bun, repo, root):
    s = Session(bun, repo, root)
    try:
        s.until("/help · /status · /login")
        s.until("│ idle")  # Banner output precedes raw editor ownership.
        s.send("/mcp connect fixture\n")
        s.until("340 tools")
        s.send("approval-eof\n")
        s.pump()
        s.release("approval-eof")
        s.until("Allow this exact external call? Type yes:")
        s.send("\x04")
        deadline = time.monotonic() + 5
        while s.process.poll() is None and time.monotonic() < deadline: s.pump(0.05)
        assert s.process.poll() == 0, "EOF at approval did not close"
        result = (s.root / "approvals.jsonl").read_text()
        assert '"isError":true' in result, result
    finally: s.close()

def exercise_dumb(bun, repo, root):
    s = Session(bun, repo, root, term="dumb")
    try:
        s.until("/help · /status · /login")
        s.send("/mcp connect fixture\n")
        s.until("340 tools")
        s.send("approval-dumb\n")
        s.until("Preparing approval.")
        s.send("yes")  # Still held in the OS's cooked-input buffer, not readline.
        s.pump()
        s.release("approval-dumb")
        s.until("approval denied")
        s.until("Approval result: denied")
        s.send("\x15/exit\n")  # Clear the cooked draft before submitting exit.
        deadline = time.monotonic() + 5
        while s.process.poll() is None and time.monotonic() < deadline: s.pump(0.05)
        assert s.process.poll() == 0, "Plain terminal did not exit"
        assert s.requests() == ["approval-dumb"]
        assert b"\x1b[" not in s.raw, "TERM=dumb emitted terminal escapes"
    finally: s.close()

def terminate(signum, _frame):
    # Let active exercise finally-blocks clean up their child on the Bun deadline.
    raise SystemExit(128 + signum)

if __name__ == "__main__":
    signal.signal(signal.SIGTERM, terminate)
    bun, root = sys.argv[1:]
    repo = pathlib.Path(__file__).resolve().parents[2]
    for no_color in (False, True):
        case = pathlib.Path(root) / ("plain" if no_color else "color"); case.mkdir()
        exercise(bun, repo, str(case), no_color)
    eof = pathlib.Path(root) / "eof"; eof.mkdir()
    exercise_eof(bun, repo, str(eof))
    dumb = pathlib.Path(root) / "dumb"; dumb.mkdir()
    exercise_dumb(bun, repo, str(dumb))
    print("PTY PASS: streaming, draft/cursor preservation, busy Enter, Ctrl-C, fresh deny/approve/cancel/EOF, local status/login, color, NO_COLOR and TERM=dumb fail-closed approvals")
