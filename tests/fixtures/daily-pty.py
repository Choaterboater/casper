"""Exercise the offline UI demo in a real terminal, including native resize."""
import fcntl
import importlib.util
import os
import pathlib
import signal
import struct
import sys
import termios

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("terminal_pty", pathlib.Path(__file__).with_name("terminal-pty.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
signal.signal(signal.SIGTERM, module.terminate)
bun, root = sys.argv[1:]
repo = pathlib.Path(__file__).resolve().parents[2]
s = module.Session(bun, repo, root, app="tools/terminal-demo.ts")
try:
    s.until("ctx 28%~")
    s.send("/model\n")
    s.until("All models")
    s.send("\t\x1b[B\n")  # /model opens on the providers: Tab to the list, Down, Enter.
    s.until("Demo state: model=fixture/beta")
    s.send("/effort\n")
    s.until("Reasoning effort")
    s.send("\x1b[B\n")
    s.until("effort=high")
    # Real terminal resize, not just a callback on an in-memory writer.
    fcntl.ioctl(s.master, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 48, 0, 0))
    s.screen.width = 48
    os.kill(s.process.pid, signal.SIGWINCH)
    s.pump(0.2)
    s.send("try the fixture\n")
    s.until("src/example.ts")
    s.send("\x1b")
    s.until("Synthetic work cancelled")
    # Enter while the cancelled work still winds down only keeps a draft: wait for the prompt first.
    s.until_ready()
    s.send("/exit\n")
    assert s.wait_exit() == 0, s.screen.text()[-3000:]
    assert b"\x1b[?1049h" not in s.raw, "alternate screen used"
    print("DAILY PTY PASS: offline model/effort, resize, cancellation and exit")
finally:
    (s.root / "transcript.txt").write_bytes(s.raw)
    s.close()
