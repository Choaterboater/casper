import { StdinBuffer, type Terminal } from "@earendil-works/pi-tui";
import type { RuntimePickerIO } from "../runtime/types";

/** The single raw-input lease shared by Casper's editor and exclusive raw flows such as login. */
export class StreamTerminal implements Terminal {
  private buffer?: StdinBuffer;
  private onInput?: (data: string) => void;
  private readonly inputHandler = (data: Buffer | string) => this.buffer?.process(data);
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
    this.io.input.off("end", this.eof);
    this.buffer?.destroy(); this.buffer = undefined;
  }
  /** Reclaim raw input. A fresh buffer forgets partial escape/paste state left by the other reader. */
  resumeInput(): void {
    if (this.stopped) return;
    this.buffer?.destroy();
    const buffer = this.buffer = new StdinBuffer();
    buffer.on("data", data => { if (!this.stopped && this.buffer === buffer) this.onInput?.(data); });
    buffer.on("paste", text => { if (!this.stopped && this.buffer === buffer) this.onInput?.(`\x1b[200~${text}\x1b[201~`); });
    this.io.input.setRawMode?.(true);
    this.io.input.on("data", this.inputHandler);
    this.io.input.once("end", this.eof);
    this.io.input.resume();
    this.write("\x1b[?2004h");
  }
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.suspendInput();
    if (this.resizeHandler) this.io.output.off?.("resize", this.resizeHandler);
    this.io.input.setRawMode?.(this.wasRaw);
    this.io.input.pause();
    this.write("\x1b[?2004l");
  }
  async drainInput(): Promise<void> {}
  write(data: string): void { this.io.output.write(this.io.color ? data : withoutColour(data)); }
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
