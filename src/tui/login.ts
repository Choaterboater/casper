import { isKeyRelease, StdinBuffer, matchesKey, SelectList, Text, TuiMainScreen } from "@earendil-works/pi-tui";
import type { RuntimePickerIO } from "../runtime/types";
import { terminalText } from "./format";
import { Panel, panelColor } from "./presentation";
import { StreamTerminal } from "./stream-terminal";

interface LoginDisplay {
  signal: AbortSignal;
  choose<T extends string>(title: string, items: readonly { id: T; label: string }[]): Promise<T | undefined>;
  consent(destination: string, provider: string, method: string, disclosure: string): Promise<boolean>;
  privateInput(label: string, signal?: AbortSignal): Promise<string>;
  device(url: string, code: string): void;
  browser(url: string): void;
}

/** Exclusive auth input: no shared editor, history, undo/yank, raw secret echo or browser launch. */
export async function withLoginDisplay<T>(io: RuntimePickerIO, parentSignal: AbortSignal,
  work: (display: LoginDisplay) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const signal = AbortSignal.any([parentSignal, controller.signal]);
  let buffer = new StdinBuffer();
  const wasRaw = io.input.isRaw ?? false;
  let closed = false;
  let answer: ((key: string) => void) | undefined;
  let paste: ((text: string) => void) | undefined;
  let singleKey = true;
  let selecting = false;
  let inputBytes = 0;
  let screen: TuiMainScreen | undefined;
  const accent = (text: string) => panelColor(text, "accent", io.color);
  const muted = (text: string) => panelColor(text, "muted", io.color);
  const stopScreen = () => { screen?.stop(); screen = undefined; };
  const mount = (panel: Panel) => {
    stopScreen();
    const tui = new TuiMainScreen(new LoginPickerTerminal(io));
    tui.addChild(panel); screen = tui;
    return tui;
  };
  const write = (text: string) => { if (!closed && !signal.aborted) io.output.write(text); };
  const cancel = () => { controller.abort(); answer?.(""); };
  const eof = () => { cancel(); io.onEOF(); };
  const bind = () => {
    buffer.on("data", (key) => {
      if (isKeyRelease(key)) return;
      if (matchesKey(key, "ctrl+d")) { eof(); return; }
      if (matchesKey(key, "escape") || matchesKey(key, "ctrl+c")) { cancel(); return; }
      // Parsed picker keys may be batched; consent and private submission still require a fresh key.
      if (selecting || singleKey || (paste && !matchesKey(key, "enter"))) answer?.(key);
    });
    buffer.on("paste", (text) => paste?.(text));
  };
  bind();
  const data = (chunk: Buffer | string) => {
    inputBytes += Buffer.byteLength(chunk);
    if (inputBytes > 32_768) { cancel(); buffer.destroy(); return; }
    const text = chunk.toString();
    singleKey = /^(?:[\x20-\x7e\r\n\x7f]|\x1b\[[AB])$/.test(text);
    buffer.process(chunk);
  };
  const fresh = async () => {
    stopScreen();
    answer = undefined; paste = undefined; selecting = false; inputBytes = 0;
    buffer.destroy(); buffer = new StdinBuffer(); bind();
    // Never reuse keys or partial escape/paste state from the preceding step.
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const ask = async <V>(panel: Panel, accept: (key: string) => V | undefined): Promise<V | undefined> => {
    await fresh();
    if (signal.aborted) return undefined;
    const tui = mount(panel);
    return new Promise((resolve) => {
      answer = (key) => {
        const result = signal.aborted ? undefined : accept(key);
        if (result === undefined && !signal.aborted) return;
        answer = undefined; stopScreen(); resolve(result);
      };
      tui.start(); tui.renderNow();
    });
  };
  signal.addEventListener("abort", cancel, { once: true });
  io.input.on("data", data); io.input.once("end", eof); io.input.once("close", eof);
  io.input.setRawMode?.(true); io.input.resume();
  try {
    write("\x1b[?2004h");
    return await work({ signal,
      choose: async (title, items) => {
        await fresh();
        if (signal.aborted) return undefined;
        const list = new SelectList([...items.map((item, index) => ({ value: String(index), label: terminalText(item.label) })),
          { value: String(items.length), label: "Cancel" }], 8,
        { selectedPrefix: accent, selectedText: accent, description: muted, scrollInfo: muted, noMatch: text => panelColor(text, "warning", io.color) });
        const panel = new Panel(`Login · ${terminalText(title)}`, io.color);
        panel.addChild(new Text(muted("Up/Down: choose · Enter: continue"), 0, 1));
        panel.addChild(list);
        panel.addChild(new Text("Esc / Ctrl+C: cancel login", 0, 1));
        const tui = mount(panel);
        try {
          const choice = await new Promise<number | undefined>(resolve => {
            const finish = (index?: number) => {
              // Detach before StdinBuffer can dispatch another key from this chunk.
              answer = undefined; selecting = false;
              stopScreen(); resolve(index);
            };
            list.onSelect = item => finish(Number(item.value));
            list.onCancel = () => finish();
            selecting = true;
            answer = key => {
              if (signal.aborted) { finish(); return; }
              if (matchesKey(key, "up") || matchesKey(key, "down") || matchesKey(key, "enter")) {
                list.handleInput(key);
                if (selecting) tui.requestRender();
              }
            };
            tui.start(); tui.renderNow();
          });
          return choice === undefined ? undefined : items[choice]?.id;
        } finally { stopScreen(); answer = undefined; selecting = false; }
      },
      consent: async (destination, provider, method, disclosure) => {
        const panel = new Panel("Review sign-in consent", io.color, "warning");
        panel.addChild(new Text(`Sign in to ${terminalText(provider)} using ${terminalText(method)}?`, 0, 1));
        panel.addChild(new Text(`${accent("Credential change")}\nOn success, save or replace only the ${terminalText(provider)} credential.\nDestination:\n${terminalText(destination)}`, 0, 0));
        panel.addChild(new Text(`${accent("Shared access")}\nPi and Casper parent/child/learning runtimes use this store.`, 0, 1));
        panel.addChild(new Text(`${accent("Account impact")}\n${terminalText(disclosure)}`, 0, 0));
        panel.addChild(new Text(`${accent("Unchanged")}\nModel choices and defaults will not change.\nNo browser opens automatically.`, 0, 1));
        panel.addChild(new Text("Press Y to consent\nEsc / Ctrl+C: cancel", 0, 0));
        return (await ask(panel, key => key === "y" || key === "Y" ? true : undefined)) === true;
      },
      privateInput: async (label, promptSignal) => {
        await fresh();
        const inputSignal = AbortSignal.any([signal, ...(promptSignal ? [promptSignal] : [])]);
        inputSignal.throwIfAborted();
        const panel = new Panel("Enter private login input", io.color, "warning");
        panel.addChild(new Text(terminalText(label), 0, 1));
        panel.addChild(new Text("1. Paste or type here. Input stays hidden.\n2. Press Enter separately to submit.", 0, 0));
        panel.addChild(new Text("Never enter keys, codes or redirect URLs in chat.\nEsc / Ctrl+C: cancel", 0, 1));
        const status = new Text(muted("Private input: [empty]"), 0, 0);
        panel.addChild(status);
        const tui = mount(panel);
        return new Promise<string>((resolve, reject) => {
          let value = "";
          const cleanup = () => { value = ""; answer = undefined; paste = undefined; inputSignal.removeEventListener("abort", abort); stopScreen(); };
          const abort = () => { cleanup(); reject(new Error("Login input cancelled")); };
          const append = (text: string) => {
            // Keys and redirects are printable ASCII. Reject rather than strip controls/newlines.
            if (!/^[\x21-\x7e]*$/.test(text) || value.length + text.length > 8192) {
              cleanup(); reject(new Error("Invalid private input")); return;
            }
            value += text;
            status.setText(muted(value ? "Private input: [hidden]" : "Private input: [empty]"));
            tui.requestRender();
          };
          inputSignal.addEventListener("abort", abort, { once: true });
          paste = append;
          answer = (key) => {
            if (inputSignal.aborted) { abort(); return; }
            if (matchesKey(key, "enter")) {
              if (!value) return;
              const result = value; cleanup(); write("Private input received.\n"); resolve(result);
            } else if (matchesKey(key, "backspace")) { value = value.slice(0, -1); append(""); }
            else if (/^[\x20-\x7e]+$/.test(key)) append(key);
            // Navigation, history, undo, clipboard and editor commands have no meaning here.
          };
          tui.start(); tui.renderNow();
        });
      },
      device: (url, code) => {
        if (signal.aborted) return;
        stopScreen();
        // Keep copyable values outside frames: terminal soft-wrap adds no separators.
        write(`${accent("1. Open this URL in your browser:")}\n${terminalText(url)}\n${accent("2. Enter this one-time code:")}\n${terminalText(code)}\n`);
        const panel = new Panel("Approve sign-in in your browser", io.color);
        panel.addChild(new Text("3. Complete the provider's authorization steps.\nWaiting for authorization.", 0, 1));
        panel.addChild(new Text("No browser opens automatically.\nDo not paste credentials here.\nEsc / Ctrl+C: cancel", 0, 0));
        const tui = mount(panel);
        tui.start(); tui.renderNow();
      },
      browser: (url) => {
        if (signal.aborted) return;
        stopScreen();
        write(`${accent("1. Open this URL in your browser:")}\n${terminalText(url)}\n`);
        const panel = new Panel("Complete browser sign-in", io.color);
        panel.addChild(new Text("2. Complete the provider's authorization steps.\nWaiting for browser authorization.", 0, 1));
        panel.addChild(new Text("No browser opens automatically.\nCodes and redirect URLs belong only in the private login prompt.\nEsc / Ctrl+C: cancel", 0, 0));
        const tui = mount(panel);
        tui.start(); tui.renderNow();
      },
    });
  } finally {
    stopScreen();
    closed = true;
    signal.removeEventListener("abort", cancel);
    controller.abort(); answer = undefined; paste = undefined; buffer.destroy();
    await new Promise<void>((resolve) => setImmediate(resolve));
    io.input.off("data", data); io.input.off("end", eof); io.input.off("close", eof);
    io.input.pause();
    io.output.write("\x1b[?2004l"); io.input.setRawMode?.(wasRaw);
  }
}

/** Borrow login's raw-input lease: only rendering and resize belong to the picker. */
class LoginPickerTerminal extends StreamTerminal {
  private redraw?: () => void;
  constructor(private readonly pickerIO: RuntimePickerIO) { super(pickerIO, pickerIO.onEOF); }
  override start(_onInput: (data: string) => void, onResize: () => void): void {
    this.redraw = onResize;
    this.pickerIO.output.on?.("resize", onResize);
  }
  override stop(): void {
    if (this.redraw) this.pickerIO.output.off?.("resize", this.redraw);
    this.redraw = undefined;
  }
}
