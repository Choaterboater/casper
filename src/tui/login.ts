import { isKeyRelease, StdinBuffer, matchesKey, SelectList, Text } from "@earendil-works/pi-tui";
import type { RuntimeLoginIO } from "../runtime/types";
import { terminalText } from "./format";
import { Panel, panelColor } from "./presentation";

interface LoginDisplay {
  signal: AbortSignal;
  choose<T extends string>(title: string, items: readonly { id: T; label: string }[]): Promise<T | undefined>;
  /** A short muted note under every later screen: where the key is saved, and what the provider charges. */
  setNote(text: string): void;
  privateInput(label: string, signal?: AbortSignal): Promise<string>;
  device(url: string, code: string): void;
  browser(url: string): void;
}

/** The program and arguments that open `url` in the system browser. On Windows not `cmd /c start`: cmd reads the
 * "&" between a sign-in address's query parts as "run another command" and the browser gets only the first part. */
export function browserCommand(url: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "darwin") return ["open", url];
  if (platform === "win32") return [`${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\rundll32.exe`, "url.dll,FileProtocolHandler", url];
  return ["xdg-open", url];
}

/** Open the system browser for a validated authorization URL. Suppressed in offline mode
 * (CASPER_OFFLINE=1), where the URL stays printed for manual opening. The URL itself was already
 * validated (https + known provider origin) before display. */
function launchBrowser(url: string): boolean {
  if (process.env.CASPER_OFFLINE === "1") return false;
  try {
    const child = Bun.spawn(browserCommand(url), { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    child.unref();
    return true;
  } catch { return false; }
}

/** Exclusive auth input: no shared editor, history, undo/yank or raw secret echo. The system
 * browser opens only validated authorization URLs. */
export async function withLoginDisplay<T>(io: RuntimeLoginIO, parentSignal: AbortSignal,
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
  let note = "";
  const accent = (text: string) => panelColor(text, "accent", io.color);
  const muted = (text: string) => panelColor(text, "muted", io.color);
  const clearPanel = () => io.show();
  const mount = (panel: Panel) => io.show(panel);
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
    clearPanel();
    answer = undefined; paste = undefined; selecting = false; inputBytes = 0;
    buffer.destroy(); buffer = new StdinBuffer(); bind();
    // Never reuse keys or partial escape/paste state from the preceding step.
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  signal.addEventListener("abort", cancel, { once: true });
  io.input.on("data", data); io.input.once("end", eof); io.input.once("close", eof);
  io.input.setRawMode?.(true); io.input.resume();
  try {
    return await work({ signal,
      choose: async (title, items) => {
        await fresh();
        if (signal.aborted) return undefined;
        // Numbered rows: a digit picks its row at once, Enter picks the highlighted one (1 at first). Esc cancels.
        const list = new SelectList(items.map((item, index) => ({ value: String(index), label: `${index + 1} ${terminalText(item.label)}` })), 9,
        { selectedPrefix: accent, selectedText: accent, description: muted, scrollInfo: muted, noMatch: text => panelColor(text, "warning", io.color) });
        const panel = new Panel(terminalText(title), io.color);
        panel.addChild(list);
        if (note) panel.addChild(new Text(muted(terminalText(note)), 0, 0));
        panel.addChild(new Text(muted(items.length > 1 ? `Type a number (1-${Math.min(items.length, 9)}), or Up/Down and Enter · Esc cancels` : "Enter continues · Esc cancels"), 0, 1));
        mount(panel);
        try {
          const choice = await new Promise<number | undefined>(resolve => {
            const finish = (index?: number) => {
              // Detach before StdinBuffer can dispatch another key from this chunk.
              answer = undefined; selecting = false;
              clearPanel(); resolve(index);
            };
            list.onSelect = item => finish(Number(item.value));
            list.onCancel = () => finish();
            selecting = true;
            answer = key => {
              if (signal.aborted) { finish(); return; }
              const digit = /^[1-9]$/.test(key) ? Number(key) - 1 : -1;
              if (digit >= 0 && digit < items.length) { finish(digit); return; }
              if (matchesKey(key, "up") || matchesKey(key, "down") || matchesKey(key, "enter")) {
                list.handleInput(key);
                if (selecting) io.requestRender();
              }
            };
            io.requestRender();
          });
          return choice === undefined ? undefined : items[choice]?.id;
        } finally { clearPanel(); answer = undefined; selecting = false; }
      },
      setNote: (text) => { note = text; },
      privateInput: async (label, promptSignal) => {
        await fresh();
        const inputSignal = AbortSignal.any([signal, ...(promptSignal ? [promptSignal] : [])]);
        inputSignal.throwIfAborted();
        const panel = new Panel("Enter private login input", io.color, "warning");
        panel.addChild(new Text(terminalText(label), 0, 1));
        panel.addChild(new Text("1. Paste or type here. Input stays hidden.\n2. Press Enter separately to submit.", 0, 0));
        panel.addChild(new Text("Never enter keys, codes or redirect URLs in chat.\nEsc / Ctrl+C: cancel", 0, 1));
        if (note) panel.addChild(new Text(muted(terminalText(note)), 0, 0));
        const status = new Text(muted("Private input: [empty]"), 0, 0);
        panel.addChild(status);
        mount(panel);
        return new Promise<string>((resolve, reject) => {
          let value = "";
          const cleanup = () => { value = ""; answer = undefined; paste = undefined; inputSignal.removeEventListener("abort", abort); clearPanel(); };
          const abort = () => { cleanup(); reject(new Error("Login input cancelled")); };
          const append = (text: string) => {
            // Keys and redirects are printable ASCII. Reject rather than strip controls/newlines.
            if (!/^[\x21-\x7e]*$/.test(text) || value.length + text.length > 8192) {
              cleanup(); reject(new Error("Invalid private input")); return;
            }
            value += text;
            status.setText(muted(value ? `Private input: ${value.length} characters (hidden)` : "Private input: [empty]"));
            io.requestRender();
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
          io.requestRender();
        });
      },
      device: (url, code) => {
        if (signal.aborted) return;
        clearPanel();
        // Keep copyable values outside frames: terminal soft-wrap adds no separators.
        write(`${accent("1. Open this URL in your browser:")}\n${terminalText(url)}\n${accent("2. Enter this one-time code:")}\n${terminalText(code)}\n`);
        const panel = new Panel("Approve sign-in in your browser", io.color);
        panel.addChild(new Text("3. Complete the provider's authorization steps.\nWaiting for authorization.", 0, 1));
        panel.addChild(new Text("No browser opens automatically.\nDo not paste credentials here.\nEsc / Ctrl+C: cancel", 0, 0));
        if (note) panel.addChild(new Text(muted(terminalText(note)), 0, 1));
        mount(panel);
      },
      browser: (url) => {
        if (signal.aborted) return;
        clearPanel();
        write(`${accent("1. Open this URL in your browser:")}\n${terminalText(url)}\n`);
        const launched = launchBrowser(url);
        const panel = new Panel("Complete browser sign-in", io.color);
        panel.addChild(new Text(launched
          ? "2. Your browser is opening the sign-in page. Complete the provider's authorization steps.\nWaiting for browser authorization."
          : "2. Automatic launch is unavailable; open the URL above in your browser.\nWaiting for browser authorization.", 0, 1));
        panel.addChild(new Text("If the browser is on another machine, paste the final redirect URL in the private prompt.\nCodes and redirect URLs belong only in the private login prompt.\nEsc / Ctrl+C: cancel", 0, 0));
        if (note) panel.addChild(new Text(muted(terminalText(note)), 0, 1));
        mount(panel);
      },
    });
  } finally {
    clearPanel();
    closed = true;
    signal.removeEventListener("abort", cancel);
    controller.abort(); answer = undefined; paste = undefined; buffer.destroy();
    await new Promise<void>((resolve) => setImmediate(resolve));
    io.input.off("data", data); io.input.off("end", eof); io.input.off("close", eof);
    io.input.pause();
    io.input.setRawMode?.(wasRaw);
  }
}
