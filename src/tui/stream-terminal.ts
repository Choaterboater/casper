import { StdinBuffer, type Terminal } from "@earendil-works/pi-tui";
import type { RuntimePickerIO } from "../runtime/types";

/** The single raw-input lease shared by Casper's editor and exclusive pickers. */
export class StreamTerminal implements Terminal {
  private buffer?: StdinBuffer;
  private inputHandler?: (data: Buffer | string) => void;
  private resizeHandler?: () => void;
  private wasRaw = false;
  private stopped = true;
  readonly kittyProtocolActive = false;
  constructor(private readonly io: RuntimePickerIO, private readonly eof: () => void) {}
  get columns(): number { return this.io.output.columns ?? 80; }
  get rows(): number { return this.io.output.rows ?? 24; }
  start(onInput: (data: string) => void, onResize: () => void): void {
    this.stopped = false;
    this.wasRaw = this.io.input.isRaw ?? false;
    this.io.input.setRawMode?.(true);
    this.buffer = new StdinBuffer();
    this.buffer.on("data", data => { if (!this.stopped) onInput(data); });
    this.buffer.on("paste", text => { if (!this.stopped) onInput(`\x1b[200~${text}\x1b[201~`); });
    this.inputHandler = data => this.buffer?.process(data);
    this.resizeHandler = onResize;
    this.io.input.on("data", this.inputHandler);
    this.io.input.once("end", this.eof);
    this.io.output.on?.("resize", onResize);
    this.io.input.resume();
    this.write("\x1b[?2004h");
  }
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.inputHandler) this.io.input.off("data", this.inputHandler);
    this.io.input.off("end", this.eof);
    if (this.resizeHandler) this.io.output.off?.("resize", this.resizeHandler);
    this.buffer?.destroy(); this.buffer = undefined;
    this.io.input.setRawMode?.(this.wasRaw);
    this.io.input.pause();
    this.write("\x1b[?2004l");
  }
  async drainInput(): Promise<void> {}
  write(data: string): void { this.io.output.write(this.io.color ? data : data.replace(/\x1b\[[0-9;:]*m/g, "")); }
  moveBy(lines: number): void { if (lines) this.write(`\x1b[${Math.abs(lines)}${lines > 0 ? "B" : "A"}`); }
  hideCursor(): void { this.write("\x1b[?25l"); }
  showCursor(): void { this.write("\x1b[?25h"); }
  clearLine(): void { this.write("\x1b[2K"); }
  clearFromCursor(): void { this.write("\x1b[J"); }
  clearScreen(): void { this.write("\x1b[2J\x1b[H"); }
  setTitle(): void {}
  setProgress(): void {}
}
