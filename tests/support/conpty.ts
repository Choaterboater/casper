// A real Windows pseudo-console (ConPTY) for screen tests. Bun.spawn's `terminal` option opens one on Windows,
// so this needs no extra package. ConPTY redraws its own copy of the screen with cursor moves, so the Screen
// below keeps a fixed grid (plus the lines scrolled off the top) rather than a plain text log. Every character is
// one cell: wide ones (CJK, most emoji) would be off by one, and Casper draws none of those itself.

/** Keys as Windows Terminal sends them: ConPTY asks for win32-input-mode (CSI ? 9001 h), so each press is a
 * key-down and key-up record (CSI Vk;Sc;Uc;Kd;Cs;Rc _) that the console turns into what the program reads. */
const KEYS = {
  enter: [13, 28, 13, 0], escape: [27, 1, 27, 0], "ctrl+c": [67, 46, 3, 8], "shift+tab": [9, 15, 9, 16],
  "ctrl+enter": [13, 28, 10, 8], "shift+enter": [13, 28, 13, 16], up: [38, 72, 0, 256], down: [40, 80, 0, 256],
} as const;
export type KeyName = keyof typeof KEYS;
const win32Key = (name: KeyName) => {
  const [vk, sc, uc, state] = KEYS[name];
  const record = (down: 0 | 1) => "\x1b[" + [vk, sc, uc, down, state, 1].join(";") + "_";
  return record(1) + record(0);
};

export class Screen {
  history: string[] = [];
  private grid: string[][] = [];
  private x = 0;
  private y = 0;
  private wrapNext = false;
  private top = 0;
  private bottom: number;
  private saved = { x: 0, y: 0 };
  private pending = "";

  constructor(public cols: number, public rows: number) {
    this.bottom = rows - 1;
    for (let i = 0; i < rows; i++) this.grid.push(this.blank());
  }

  private blank() { return Array.from({ length: this.cols }, () => " "); }

  resize(cols: number, rows: number) {
    // Keep the bottom of the old screen: extra rows at the top go to history, as a terminal does.
    while (this.grid.length > rows) { const line = this.grid.shift()!; this.history.push(line.join("").trimEnd()); this.y--; }
    while (this.grid.length < rows) this.grid.push(Array.from({ length: cols }, () => " "));
    this.grid = this.grid.map(row => row.length >= cols ? row.slice(0, cols) : [...row, ...Array.from({ length: cols - row.length }, () => " ")]);
    this.cols = cols; this.rows = rows; this.top = 0; this.bottom = rows - 1;
    this.y = Math.max(0, Math.min(this.y, rows - 1)); this.x = Math.min(this.x, cols - 1); this.wrapNext = false;
  }

  private scrollUp(n = 1) {
    for (let i = 0; i < n; i++) {
      const [line] = this.grid.splice(this.top, 1);
      if (this.top === 0) this.history.push(line!.join("").trimEnd());
      this.grid.splice(this.bottom, 0, this.blank());
    }
  }

  private scrollDown(n = 1) {
    for (let i = 0; i < n; i++) { this.grid.splice(this.bottom, 1); this.grid.splice(this.top, 0, this.blank()); }
  }

  private lineFeed() {
    if (this.y === this.bottom) this.scrollUp();
    else if (this.y < this.rows - 1) this.y++;
  }

  private put(char: string) {
    if (this.wrapNext) { this.x = 0; this.lineFeed(); this.wrapNext = false; }
    this.grid[this.y]![this.x] = char;
    if (this.x === this.cols - 1) this.wrapNext = true;
    else this.x++;
  }

  private clamp() {
    this.x = Math.max(0, Math.min(this.x, this.cols - 1));
    this.y = Math.max(0, Math.min(this.y, this.rows - 1));
    this.wrapNext = false;
  }

  private csi(params: string, final: string) {
    if (params.startsWith("?") || params.startsWith(">") || params.startsWith("=")) return; // modes and queries
    const args = params.split(";").map(value => Number.parseInt(value, 10));
    const n = Number.isFinite(args[0]) && args[0]! > 0 ? args[0]! : 1;
    const row = this.grid[this.y]!;
    switch (final) {
      case "A": this.y = Math.max(this.y >= this.top ? this.top : 0, this.y - n); this.clamp(); break;
      case "B": case "e": this.y = Math.min(this.y <= this.bottom ? this.bottom : this.rows - 1, this.y + n); this.clamp(); break;
      case "C": case "a": this.x += n; this.clamp(); break;
      case "D": this.x -= n; this.clamp(); break;
      case "E": this.x = 0; this.y += n; this.clamp(); break;
      case "F": this.x = 0; this.y -= n; this.clamp(); break;
      case "G": case "`": this.x = n - 1; this.clamp(); break;
      case "d": this.y = n - 1; this.clamp(); break;
      case "H": case "f": {
        const r = Number.isFinite(args[0]) && args[0]! > 0 ? args[0]! : 1;
        const c = Number.isFinite(args[1]) && args[1]! > 0 ? args[1]! : 1;
        this.y = r - 1; this.x = c - 1; this.clamp(); break;
      }
      case "J": {
        const mode = args[0] || 0;
        if (mode === 0) { row.fill(" ", this.x); for (let i = this.y + 1; i < this.rows; i++) this.grid[i] = this.blank(); }
        else if (mode === 1) { row.fill(" ", 0, this.x + 1); for (let i = 0; i < this.y; i++) this.grid[i] = this.blank(); }
        else if (mode === 2 || mode === 3) for (let i = 0; i < this.rows; i++) this.grid[i] = this.blank();
        break;
      }
      case "K": {
        const mode = args[0] || 0;
        if (mode === 0) row.fill(" ", this.x); else if (mode === 1) row.fill(" ", 0, this.x + 1); else row.fill(" ");
        break;
      }
      case "X": row.fill(" ", this.x, Math.min(this.cols, this.x + n)); break;
      case "P": row.splice(this.x, n); while (row.length < this.cols) row.push(" "); break;
      case "@": row.splice(this.x, 0, ...Array.from({ length: n }, () => " ")); row.length = this.cols; break;
      case "L": if (this.y >= this.top && this.y <= this.bottom) for (let i = 0; i < n; i++) { this.grid.splice(this.bottom, 1); this.grid.splice(this.y, 0, this.blank()); } break;
      case "M": if (this.y >= this.top && this.y <= this.bottom) for (let i = 0; i < n; i++) { this.grid.splice(this.y, 1); this.grid.splice(this.bottom, 0, this.blank()); } break;
      case "S": this.scrollUp(n); break;
      case "T": this.scrollDown(n); break;
      case "r": {
        this.top = Number.isFinite(args[0]) && args[0]! > 0 ? args[0]! - 1 : 0;
        this.bottom = Number.isFinite(args[1]) && args[1]! > 0 ? Math.min(args[1]! - 1, this.rows - 1) : this.rows - 1;
        this.x = 0; this.y = 0; this.wrapNext = false; break;
      }
      case "s": this.saved = { x: this.x, y: this.y }; break;
      case "u": this.x = this.saved.x; this.y = this.saved.y; this.clamp(); break;
      default: break; // m (colors), n (reports), t, q: draw nothing
    }
  }

  feed(text: string) {
    this.pending += text;
    let i = 0;
    const s = this.pending;
    while (i < s.length) {
      const char = s[i]!;
      if (char === "\x1b") {
        const next = s[i + 1];
        if (next === undefined) break;
        if (next === "[") {
          const match = /^\x1b\[([0-9;:?<=>!]*)[ -/]*([@-~])/.exec(s.slice(i, i + 64));
          if (!match) { if (s.length - i < 64) break; throw new Error("Unhandled terminal escape: " + JSON.stringify(s.slice(i, i + 24))); }
          this.csi(match[1]!, match[2]!);
          i += match[0].length; continue;
        }
        if (next === "]" || next === "P" || next === "_" || next === "^") {
          // OSC (title, links) and other strings draw nothing; they end at BEL or ESC \.
          const bel = s.indexOf("\x07", i + 2);
          const st = s.indexOf("\x1b\\", i + 2);
          const ends = [bel === -1 ? Infinity : bel + 1, st === -1 ? Infinity : st + 2];
          const end = Math.min(...ends);
          if (end === Infinity) break;
          i = end; continue;
        }
        if (next === "(" || next === ")" || next === "#") { if (i + 2 >= s.length) break; i += 3; continue; }
        if (next === "7") this.saved = { x: this.x, y: this.y };
        else if (next === "8") { this.x = this.saved.x; this.y = this.saved.y; this.clamp(); }
        else if (next === "M") { if (this.y === this.top) this.scrollDown(); else this.y = Math.max(0, this.y - 1); }
        else if (next === "D") this.lineFeed();
        else if (next === "E") { this.x = 0; this.lineFeed(); }
        i += 2; continue;
      }
      const code = s.codePointAt(i)!;
      const width = code > 0xffff ? 2 : 1;
      if (char === "\r") { this.x = 0; this.wrapNext = false; }
      else if (char === "\n" || char === "\v" || char === "\f") { this.lineFeed(); this.wrapNext = false; }
      else if (char === "\b") { this.x = Math.max(0, this.x - 1); this.wrapNext = false; }
      else if (char === "\t") { this.x = Math.min(this.cols - 1, (Math.floor(this.x / 8) + 1) * 8); }
      else if (code >= 32 && code !== 0x7f) this.put(String.fromCodePoint(code));
      i += width;
    }
    this.pending = s.slice(i);
  }

  /** The rows on screen now, right-trimmed. */
  visible(): string { return this.grid.map(row => row.join("").trimEnd()).join("\n"); }
  /** Everything: scrolled-off lines then the screen. */
  text(): string { return [...this.history, ...this.grid.map(row => row.join("").trimEnd())].join("\n"); }
}

export type ConptyOptions = { cwd: string; env: Record<string, string>; cols?: number; rows?: number };

export class ConptySession {
  readonly screen: Screen;
  raw = "";
  private decoder = new TextDecoder();
  private waiters = new Set<() => void>();
  readonly process: Bun.Subprocess;
  private terminal: Bun.Terminal;

  constructor(command: string[], options: ConptyOptions) {
    const cols = options.cols ?? 100;
    const rows = options.rows ?? 30;
    this.screen = new Screen(cols, rows);
    this.process = Bun.spawn(command, {
      cwd: options.cwd,
      env: options.env,
      terminal: {
        cols, rows,
        data: (_terminal, chunk) => {
          const text = this.decoder.decode(chunk, { stream: true });
          this.raw += text;
          this.screen.feed(text);
          for (const wake of this.waiters) wake();
        },
      },
    });
    this.terminal = this.process.terminal!;
  }

  /** Type text. A physical Enter is CR; LF here means Enter too. */
  send(text: string) { this.terminal.write(text.replace(/\n/g, "\r")); }
  /** Write bytes as they are (Ctrl+J is LF here). */
  write(bytes: string) { this.terminal.write(bytes); }
  /** Press a key the way Windows Terminal sends it. */
  press(name: KeyName) { this.terminal.write(win32Key(name)); }

  resize(cols: number, rows: number) {
    this.terminal.resize(cols, rows);
    this.screen.resize(cols, rows);
  }

  text() { return this.screen.text(); }
  visible() { return this.screen.visible(); }

  private changed(ms: number) {
    return new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); this.waiters.delete(done); resolve(); };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
    });
  }

  /** Wait until `check` holds for the screen; fail with the screen text after `timeout` ms. */
  async waitFor(what: string, check: () => boolean, timeout = 30_000) {
    const deadline = Date.now() + timeout;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`Missing screen text: ${what}\nSCREEN:\n${this.text().slice(-6000)}`);
      await this.changed(Math.min(100, Math.max(1, deadline - Date.now())));
    }
  }

  until(text: string, timeout?: number) { return this.waitFor(JSON.stringify(text), () => this.text().includes(text), timeout); }

  /** Wait for one more `text` than the screen holds now (a repeated prompt is already in the scrollback). */
  untilNew(text: string, timeout?: number) {
    const count = () => this.text().split(text).length - 1;
    const before = count();
    return this.waitFor("new " + JSON.stringify(text), () => count() > before, timeout);
  }

  /** The exit code, or null if it is still running after `timeout` ms. */
  async exited(timeout = 10_000): Promise<number | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeout); });
    try { return await Promise.race([this.process.exited, late]); } finally { clearTimeout(timer); }
  }

  async close() {
    if (this.process.exitCode === null && this.process.signalCode === null) {
      this.process.kill();
      await this.exited(5_000);
    }
    try { this.terminal.close(); } catch {}
  }
}
