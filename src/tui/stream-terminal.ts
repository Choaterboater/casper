import { StdinBuffer, type Terminal } from "@earendil-works/pi-tui";
import type { RuntimePickerIO } from "../runtime/types";

/** Focus reporting (xterm mode 1004): the terminal sends FOCUS_IN when it comes to the front and FOCUS_OUT when
 * it goes behind another window or tab, so the bell rings only when you are not looking. */
export const FOCUS_ON = "\x1b[?1004h";
export const FOCUS_OFF = "\x1b[?1004l";
const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";

/** The single raw-input lease shared by Casper's editor and exclusive raw flows such as login. */
export class StreamTerminal implements Terminal {
  private buffer?: StdinBuffer;
  private onInput?: (data: string) => void;
  private readonly inputHandler = (data: Buffer | string) => this.buffer?.process(data);
  private resizeHandler?: () => void;
  private wasRaw = false;
  private stopped = true;
  readonly kittyProtocolActive = false;
  /** The terminal is in front (true) or not (false), from its focus reports (mode 1004); undefined until it sends
   * one, and again after input was lent out (a report may have gone to the other reader). */
  focused?: boolean;
  /** The input itself ended or failed: the terminal closed or the connection dropped (not Ctrl+D, a key). */
  inputEnded = false;
  private readonly ended = () => { if (this.inputEnded) return; this.inputEnded = true; this.eof(); };
  constructor(private readonly io: RuntimePickerIO, private readonly eof: () => void) {}
  get columns(): number { return this.io.output.columns ?? 80; }
  get rows(): number { return this.io.output.rows ?? 24; }
  start(onInput: (data: string) => void, onResize: () => void): void {
    this.stopped = false;
    this.wasRaw = this.io.input.isRaw ?? false;
    this.onInput = onInput;
    this.resizeHandler = onResize;
    this.io.output.on?.("resize", onResize);
    this.resumeInput();
    // The window or tab says casper, not the bun or node that runs it.
    this.setTitle("casper");
  }
  /** Lend raw input to another reader while this terminal keeps rendering. */
  suspendInput(): void {
    if (this.stopped) return;
    this.io.input.off("data", this.inputHandler);
    this.io.input.off("end", this.ended);
    this.io.input.off("error", this.ended);
    this.buffer?.destroy(); this.buffer = undefined;
    // The reader input is lent to gets no focus reports.
    this.write(FOCUS_OFF);
  }
  /** Reclaim raw input. A fresh buffer forgets partial escape/paste state left by the other reader. */
  resumeInput(): void {
    if (this.stopped) return;
    this.buffer?.destroy();
    const buffer = this.buffer = new StdinBuffer();
    buffer.on("data", data => {
      if (this.stopped || this.buffer !== buffer) return;
      // Focus reports (ESC [ I in front, ESC [ O behind) are the terminal's, never a key: they never reach the editor.
      if (data === FOCUS_IN || data === FOCUS_OUT) { this.focused = data === FOCUS_IN; return; }
      this.onInput?.(data);
    });
    buffer.on("paste", text => { if (!this.stopped && this.buffer === buffer) this.onInput?.(`\x1b[200~${text}\x1b[201~`); });
    this.io.input.setRawMode?.(true);
    this.io.input.on("data", this.inputHandler);
    this.io.input.once("end", this.ended);
    // A read error on a terminal that hung up (EIO) ends input the same way, instead of throwing.
    this.io.input.on("error", this.ended);
    this.io.input.resume();
    this.focused = undefined;
    this.write("\x1b[?2004h");
    this.write(FOCUS_ON);
  }
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.suspendInput();
    if (this.resizeHandler) this.io.output.off?.("resize", this.resizeHandler);
    this.io.input.setRawMode?.(this.wasRaw);
    this.io.input.pause();
    this.write("\x1b[?2004l");
    this.write(FOCUS_OFF);
  }
  async drainInput(): Promise<void> {}
  write(data: string): void {
    // After a hang-up the terminal is gone: a write there fails, and nothing on it can be read any more.
    try { this.io.output.write(this.io.color ? data : withoutColour(data)); } catch (error) { if (!this.inputEnded) throw error; }
  }
  moveBy(lines: number): void { if (lines) this.write(`\x1b[${Math.abs(lines)}${lines > 0 ? "B" : "A"}`); }
  hideCursor(): void { this.write("\x1b[?25l"); }
  showCursor(): void { this.write("\x1b[?25h"); }
  clearLine(): void { this.write("\x1b[2K"); }
  clearFromCursor(): void { this.write("\x1b[J"); }
  clearScreen(): void { this.write("\x1b[2J\x1b[H"); }
  /** OSC 0: the window and tab title. Control characters are dropped so a title can't end the sequence early. */
  setTitle(title: string): void { this.write(`\x1b]0;${title.replace(/[\x00-\x1f\x7f-\x9f]/g, "")}\x07`); }
  setProgress(): void {}
  setProgramStatus(): void {}
}

/** NO_COLOR removes colour only. Reverse video, bold and dim stay: reverse video is the editor's
 * only cursor marker (the hardware cursor stays hidden), so stripping every SGR hid the cursor. */
function withoutColour(data: string): string {
  return data.replace(/\x1b\[([0-9;:]*)m/g, (sequence, params: string) => {
    if (!params) return sequence;
    const parts = params.split(";");
    const kept: string[] = [];
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]!;
      const code = Number(part.split(":")[0]);
      // 38/48/58 take `5;n` or `2;r;g;b` as further parameters unless written with colons.
      if ((code === 38 || code === 48 || code === 58) && !part.includes(":")) {
        index += parts[index + 1] === "5" ? 2 : parts[index + 1] === "2" ? 4 : 0;
        continue;
      }
      if ((code >= 30 && code <= 49) || (code >= 90 && code <= 107) || code === 58 || code === 59) continue;
      kept.push(part);
    }
    return kept.length ? `\x1b[${kept.join(";")}m` : "";
  });
}
