"""Exercise the offline UI demo in a real terminal, including native resize."""
import fcntl
import importlib.util
import os
import pathlib
import signal
import struct
import sys
import termios
import time

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("terminal_pty", pathlib.Path(__file__).with_name("terminal-pty.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
signal.signal(signal.SIGTERM, module.terminate)
bun, root = sys.argv[1:]
repo = pathlib.Path(__file__).resolve().parents[2]
s = module.Session(bun, repo, root, app="tools/terminal-demo.ts")
try:
    s.until("context 28% (synthetic estimate)")
    s.send("/model\n")
    s.until("Model · offline synthetic choices")
    s.send("\x1b[B\n")
    s.until("Model: fixture/beta")
    s.send("/effort\n")
    s.until("Effort · offline synthetic choices")
    s.send("\x1b[B\n")
    s.until("Effort: high")
    # Real terminal resize, not just a callback on an in-memory writer.
    fcntl.ioctl(s.master, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 48, 0, 0))
    s.screen.width = 48
    os.kill(s.process.pid, signal.SIGWINCH)
    s.pump(0.2)
    s.send("try the fixture\n")
    s.until("synthetic")
    s.send("\x1b")
    s.until("Synthetic work stopped")
    s.until("Your message")
    s.send("/exit\n")
    deadline = time.monotonic() + 5
    while s.process.poll() is None and time.monotonic() < deadline: s.pump(0.05)
    assert s.process.poll() == 0, s.screen.text()[-3000:]
    assert b"\x1b[?1049h" not in s.raw, "alternate screen used"
    print("DAILY PTY PASS: offline model/effort, resize, cancellation and exit")
finally:
    (s.root / "transcript.txt").write_bytes(s.raw)
    s.close()
