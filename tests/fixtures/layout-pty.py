"""Layout stability in a real, bounded PTY: the offline demo drives Casper's surface
through a 24x80 VT emulator that scrolls, so footer creep, scrollback wipes and
duplicated prompt boxes are observable. SHOW=1 prints every screen."""
import codecs, errno, fcntl, os, pathlib, pty, re, select, signal, struct, subprocess, sys, termios, time

ROWS, COLS = 24, 80
CSI = re.compile(r"\x1b\[([0-9;?>=]*)([A-Za-z@`~])")


class VT:
    def __init__(self, rows=ROWS, cols=COLS):
        self.rows, self.cols = rows, cols
        self.grid = [[" "] * cols for _ in range(rows)]
        self.x = self.y = 0
        self.scrollback = []
        self.pending = ""
        self.clear_screen_count = 0
        self.clear_scrollback_count = 0
        self.wrap_pending = False

    def linefeed(self):
        if self.y == self.rows - 1:
            self.scrollback.append("".join(self.grid[0]).rstrip())
            del self.grid[0]
            self.grid.append([" "] * self.cols)
        else:
            self.y += 1

    def feed(self, text):
        self.pending += text
        while self.pending:
            p = self.pending
            if p[0] == "\x1b":
                if p.startswith("\x1b]") or p.startswith("\x1b_G"):
                    m = re.match(r"\x1b(?:\].*?(?:\x07|\x1b\\)|_G.*?\x1b\\)", p, re.S)
                    if not m: break
                    self.pending = p[m.end():]; continue
                m = CSI.match(p)
                if not m:
                    if len(p) < 32: break
                    raise AssertionError("Unhandled escape " + repr(p[:32]))
                self.pending = p[m.end():]
                self.csi(m.group(1), m.group(2)); continue
            ch, self.pending = p[0], p[1:]
            if ch == "\r": self.x = 0; self.wrap_pending = False
            elif ch == "\n": self.linefeed(); self.wrap_pending = False
            elif ch == "\b": self.x = max(0, self.x - 1)
            elif ord(ch) >= 32:
                if self.wrap_pending: self.x = 0; self.linefeed(); self.wrap_pending = False
                self.grid[self.y][self.x] = ch
                if self.x == self.cols - 1: self.wrap_pending = True
                else: self.x += 1

    def csi(self, args, cmd):
        if args.startswith("?"): return  # private modes: bracketed paste, synchronized output, cursor
        nums = [int(v) if v else None for v in args.split(";")] if args else []
        n = nums[0] if nums and nums[0] is not None else 1
        if cmd == "A": self.y = max(0, self.y - n)
        elif cmd == "B": self.y = min(self.rows - 1, self.y + n)
        elif cmd == "C": self.x = min(self.cols - 1, self.x + n)
        elif cmd == "D": self.x = max(0, self.x - n)
        elif cmd == "G": self.x = min(self.cols - 1, n - 1)
        elif cmd in "Hf":
            self.y = min(self.rows - 1, (nums[0] if nums and nums[0] else 1) - 1)
            self.x = min(self.cols - 1, (nums[1] if len(nums) > 1 and nums[1] else 1) - 1)
        elif cmd == "J":
            mode = nums[0] if nums and nums[0] is not None else 0
            if mode == 0:
                self.grid[self.y][self.x:] = [" "] * (self.cols - self.x)
                for r in range(self.y + 1, self.rows): self.grid[r] = [" "] * self.cols
            elif mode == 2:
                self.clear_screen_count += 1
                self.grid = [[" "] * self.cols for _ in range(self.rows)]
            elif mode == 3:
                self.clear_scrollback_count += 1
                self.scrollback = []
        elif cmd == "K":
            mode = nums[0] if nums and nums[0] is not None else 0
            if mode == 2: self.grid[self.y] = [" "] * self.cols
            elif mode == 0: self.grid[self.y][self.x:] = [" "] * (self.cols - self.x)
            elif mode == 1: self.grid[self.y][:self.x + 1] = [" "] * (self.x + 1)
        self.wrap_pending = False

    def screen(self): return "\n".join("".join(r).rstrip() for r in self.grid)
    def everything(self): return "\n".join(self.scrollback + [self.screen()])


class Session:
    def __init__(self, cmd, cwd, env):
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
        self.process = subprocess.Popen(cmd, cwd=cwd, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        self.vt = VT(); self.decoder = codecs.getincrementaldecoder("utf-8")("replace"); self.raw = b""

    def pump(self, duration=0.1):
        deadline = time.monotonic() + duration
        while time.monotonic() < deadline:
            if select.select([self.master], [], [], max(0, deadline - time.monotonic()))[0]:
                try: data = os.read(self.master, 65536)
                except OSError as e:
                    if e.errno == errno.EIO: return
                    raise
                if not data: return
                self.raw += data; self.vt.feed(self.decoder.decode(data))

    def until(self, text, timeout=15):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.pump(0.03)
            if text in self.vt.screen(): return
        raise AssertionError(f"Missing {text!r}\nSCREEN:\n{self.vt.screen()}")

    def until_count(self, text, count, timeout=15):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.pump(0.03)
            if self.vt.everything().count(text) >= count: return
        raise AssertionError(f"Expected {count}x {text!r}\nSCREEN:\n{self.vt.screen()}")

    def send(self, text): os.write(self.master, text.replace("\n", "\r").encode())

    def resize(self, rows, cols):
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        old = self.vt
        # Approximate a reflowing terminal: keep the bottom rows, clip or pad columns.
        self.vt = VT(rows, cols)
        dropped = max(0, old.rows - rows)
        self.vt.scrollback = old.scrollback + ["".join(r).rstrip() for r in old.grid[:dropped]]
        for i, r in enumerate(old.grid[dropped:]): self.vt.grid[i] = (r + [" "] * cols)[:cols]
        self.vt.y = min(rows - 1, old.y - dropped); self.vt.x = min(cols - 1, old.x)
        self.vt.clear_screen_count = old.clear_screen_count
        self.vt.clear_scrollback_count = old.clear_scrollback_count
        os.kill(self.process.pid, signal.SIGWINCH)

    def footer_row(self):
        rows = [i for i, r in enumerate(self.vt.screen().split("\n")) if "ctx 28%" in r]
        assert len(rows) == 1, f"footer should appear exactly once, found rows {rows}\n{self.vt.screen()}"
        return rows[0]

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            try: self.process.wait(timeout=3)
            except subprocess.TimeoutExpired: self.process.kill(); self.process.wait()
        os.close(self.master)


def check(name, s, checks):
    failures = [message for ok, message in checks if not ok]
    print(f"{name}: {'FAIL' if failures else 'ok'} (2J={s.vt.clear_screen_count} 3J={s.vt.clear_scrollback_count} scrollback={len(s.vt.scrollback)})")
    if failures or os.environ.get("SHOW"):
        for f in failures: print("  -", f)
        print("  +" + "-" * s.vt.cols + "+")
        for row in s.vt.screen().split("\n"): print("  |" + row.ljust(s.vt.cols) + "|")
        print("  +" + "-" * s.vt.cols + "+")
    return not failures


def one_prompt_box(s):
    borders = [i for i, r in enumerate(s.vt.screen().split("\n")) if r.startswith("───")]
    return (len(borders) == 2, f"expected one prompt box (two border rows), found border rows {borders}")


def terminate(signum, _frame):
    raise SystemExit(128 + signum)


def main():
    signal.signal(signal.SIGTERM, terminate)
    bun = sys.argv[1]
    repo = pathlib.Path(__file__).resolve().parents[2]
    env = {"HOME": os.environ["HOME"], "PATH": os.environ["PATH"], "TERM": "xterm-256color"}
    s = Session([bun, str(repo / "tools/terminal-demo.ts")], str(repo), env)
    ok = True
    try:
        s.until("ctx 28% (fixture)")
        ok &= check("startup", s, [one_prompt_box(s), ("CASPER · OFFLINE" in s.vt.everything(), "banner visible")])
        # The startup viewport clear is Casper's own; every later phase must emit none.
        startup_clears = s.vt.clear_screen_count
        # Fill past the screen height so every later interaction happens at the bottom edge.
        for i in range(4):
            s.send(f"prompt {i}\n"); s.until_count("Demo complete. No real tools ran.", i + 1); s.pump(0.4)
        ok &= check("scrolled transcript", s, [one_prompt_box(s),
            ("prompt 3" in s.vt.screen(), "latest prompt echoed on screen"),
            ("CASPER · OFFLINE" in s.vt.everything(), "banner retained in scrollback"),
            (s.vt.clear_scrollback_count == 0, "scrollback must not be wiped while chatting")])
        footer = s.footer_row()
        assert footer == ROWS - 1, f"transcript should have reached the bottom edge, footer at row {footer}"
        for _ in range(3):
            s.send("/"); s.until("Change model"); s.send("\x7f"); s.pump(0.3)
        ok &= check("command popup opened and closed three times", s, [one_prompt_box(s),
            (s.footer_row() == footer, f"footer moved {footer} -> {s.footer_row()}: content crept upward"),
            ("Change model" not in s.vt.screen(), "popup rows restored to transcript")])
        s.send("/effort\n"); s.until("Effort · offline synthetic choices")
        ok &= check("picker open", s, [
            ("Effort · offline synthetic choices" in s.vt.screen(), "picker visible"),
            ("prompt 0" in s.vt.everything(), "transcript retained while picker is open"),
            # Casper clears the viewport once at startup; pickers must never clear mid-session.
            (s.vt.clear_screen_count == startup_clears, "opening a picker must not clear the screen")])
        s.send("\x1b[B\n"); s.until("effort=high"); s.pump(0.3)
        ok &= check("picker closed", s, [one_prompt_box(s),
            (s.footer_row() == footer, f"footer moved {footer} -> {s.footer_row()} after picker"),
            ("CASPER · OFFLINE" in s.vt.everything(), "banner retained after picker"),
            (s.vt.clear_scrollback_count == 0, "picker must not wipe terminal scrollback")])
        s.send("draft text stays"); s.pump(0.2)
        s.resize(20, 60); s.pump(0.6)
        ok &= check("resize", s, [one_prompt_box(s),
            ("draft text stays" in s.vt.screen(), "draft survives resize"),
            ("CASPER · OFFLINE" in s.vt.everything(), "banner reprinted after resize")])
        s.send("\x15/exit\n")
        deadline = time.monotonic() + 5
        while s.process.poll() is None and time.monotonic() < deadline: s.pump(0.05)
        ok &= check("exit", s, [(s.process.poll() == 0, f"exit code {s.process.poll()}")])
        assert b"\x1b[?1049h" not in s.raw, "alternate screen used"
    finally:
        s.close()
    if not ok: sys.exit(1)
    print("LAYOUT PTY PASS: no footer creep, no scrollback wipe from popups/pickers, one prompt box, resize reflow")


if __name__ == "__main__":
    main()
