import { initTheme, ModelSelectorComponent, type AgentSession, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getKeybindings, KeybindingsManager, setKeybindings, StdinBuffer, TUI_KEYBINDINGS, TuiMainScreen, type Terminal } from "@earendil-works/pi-tui";
import { terminalText } from "../tui/format";
import type { RuntimePickerIO } from "./types";

type Pick = { provider: string; id: string; persist: boolean };

/** Pi renderer over Casper-owned streams. Readline is closed for this lifetime;
 * no process-global keyboard protocol negotiation or alternate-screen takeover. */
class PickerTerminal implements Terminal {
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
    this.buffer.on("data", (data) => {
      if (this.stopped) return;
      if (data === "\x04") this.eof();
      else onInput(data);
    });
    this.buffer.on("paste", (text) => {
      if (!this.stopped) onInput(`\x1b[200~${text}\x1b[201~`);
    });
    this.inputHandler = (data) => this.buffer?.process(data);
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

export async function pickPiModel(io: RuntimePickerIO, catalog: ModelRuntime, current: AgentSession["model"],
  defaultModel: { provider: string; id: string } | undefined, query: string | undefined, signal?: AbortSignal): Promise<Pick | undefined> {
  signal?.throwIfAborted();
  const previousBindings = getKeybindings();
  setKeybindings(new KeybindingsManager({ ...TUI_KEYBINDINGS,
    "app.models.save": { defaultKeys: "ctrl+s", description: "Select and save Casper default" },
  }));
  let finish: (pick?: Pick) => void = () => {};
  let settled = false;
  const terminal = new PickerTerminal(io, () => { finish(); io.onEOF(); });
  const tui = new TuiMainScreen(terminal);
  let stopped = false;
  const stop = () => { if (!stopped) { stopped = true; tui.stop(); } };
  let picker: ModelSelectorComponent | undefined;
  const cancel = () => finish();
  // Preserve the actual Pi picker. Its refresh is explicitly local-only here,
  // and catalog text is sanitized before Pi adds its own renderer controls.
  const view = new Proxy(catalog, {
    get(target, key) {
      if (key === "getError") return () => {
        const error = target.getError();
        return error === undefined ? undefined : terminalText(error);
      };
      if (key === "refresh") return async (options: Parameters<ModelRuntime["refresh"]>[0]) => {
        try {
          const result = await target.refresh({ ...options, allowNetwork: false });
          return { ...result, errors: new Map([...result.errors].map(([provider, error]) =>
            [terminalText(provider), new Error(terminalText(error.message))])) };
        } catch (error) {
          throw new Error(terminalText(error instanceof Error ? error.message : String(error)));
        }
      };
      if (key === "getAvailableSnapshot") return () => target.getAvailableSnapshot()
        .filter((model) => [model.provider, model.id].every((value) => terminalText(value) === value && !/[\r\n\t]/.test(value)))
        .map((model) => ({ ...model, name: terminalText(model.name).replace(/\s+/g, " ") }));
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  try {
    initTheme("dark", false);
    return await new Promise<Pick | undefined>((resolve) => {
      finish = (pick) => {
        if (settled) return;
        settled = true;
        picker?.dispose();
        stop(); // Detach input now, not after more keys in the same chunk.
        resolve(pick);
      };
      picker = new ModelSelectorComponent(tui, current, view, [],
        (model) => finish({ provider: model.provider, id: model.id, persist: false }), cancel, query === undefined ? undefined : terminalText(query).replace(/[\r\n\t]/g, " "),
        (model) => finish({ provider: model.provider, id: model.id, persist: true }), defaultModel);
      tui.addChild(picker); tui.setFocus(picker);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) finish(); else tui.start();
    });
  } finally {
    signal?.removeEventListener("abort", cancel);
    picker?.dispose(); stop();
    setKeybindings(previousBindings);
  }
}
