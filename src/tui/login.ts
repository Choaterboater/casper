import { isKeyRelease, StdinBuffer, matchesKey, SelectList, Text } from "@earendil-works/pi-tui";
import type { RuntimeLoginIO } from "../runtime/types";
import { choiceHint, choiceNumber, KEY_PICK_MAX, keyChoice, typedChoice } from "./choices";
import { terminalText, tint } from "./format";
import { Panel, panelColor } from "./presentation";

/** A typed or pasted password: no control characters (an escape sequence is a key press, not text). Spaces and non-ASCII are fine. */
const PASSWORD_TEXT = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]*$/u;

export interface LoginDisplay {
  signal: AbortSignal;
  choose<T extends string>(title: string, items: readonly { id: T; label: string }[]): Promise<T | undefined>;
  /** A short muted note under every later screen: where the key is saved, and what the provider charges. */
  setNote(text: string): void;
  privateInput(label: string, signal?: AbortSignal, options?: PrivateInputOptions): Promise<string>;
  /** A box whose text shows as you type (an address, a name): nothing secret goes here. */
  textInput(label: string, signal?: AbortSignal, options?: TextInputOptions): Promise<string>;
  /** A panel with no input while something runs (Esc still cancels). */
  wait(title: string, text: string): void;
  device(url: string, code: string): void;
  browser(url: string): void;
}

/** A hidden box that is not a provider login: its own title and words, and (a password) any printable text, spaces and
 * non-ASCII letters included. Keys and codes stay printable ASCII. */
export interface PrivateInputOptions {
  title?: string;
  /** The lines under the label, in place of the key-and-redirect-URL ones. */
  hint?: string;
  password?: boolean;
}

export interface TextInputOptions {
  title?: string;
  /** The lines under the box. */
  hint?: string;
  /** The text the box starts with (a suggested name): Enter keeps it, the first key typed replaces it. */
  initial?: string;
  /** `initial` is text to fix (an address tried before), not a suggestion: typing adds to it. */
  editable?: boolean;
  /** Why the text can't be used, which keeps the box open; undefined when it can. */
  check?: (text: string) => string | undefined;
}

/** Visible text: printable ASCII only (an escape sequence is a key press, not text), 512 characters at most. */
const VISIBLE_TEXT = /^[\x20-\x7e]*$/;

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
  const selected = (text: string) => tint(text, "selection", io.color);
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
        // Numbered rows in the one choice style: a digit picks its row at once (past nine rows the number is typed,
        // then Enter), Enter picks the highlighted one (1 at first). Esc cancels.
        const list = new SelectList(items.map((item, index) => ({ value: String(index), label: `${choiceNumber(index, items.length)}${terminalText(item.label)}` })), 9,
        { selectedPrefix: selected, selectedText: selected, description: muted, scrollInfo: muted, noMatch: text => panelColor(text, "warning", io.color) });
        const panel = new Panel(terminalText(title), io.color);
        panel.addChild(list);
        if (note) panel.addChild(new Text(muted(terminalText(note)), 0, 0));
        panel.addChild(new Text(muted(choiceHint(items.length, "Esc cancels")), 0, 1));
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
            let typed = "";
            answer = key => {
              if (signal.aborted) { finish(); return; }
              const digit = keyChoice(key, items.length);
              if (digit >= 0) { finish(digit); return; }
              if (items.length > KEY_PICK_MAX && /^\d$/.test(key)) { typed += key; return; }
              if (typed && matchesKey(key, "enter")) {
                const row = typedChoice(typed, items.length);
                typed = "";
                if (row >= 0) finish(row);
                return;
              }
              typed = "";
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
      privateInput: async (label, promptSignal, inputOptions) => {
        await fresh();
        const inputSignal = AbortSignal.any([signal, ...(promptSignal ? [promptSignal] : [])]);
        inputSignal.throwIfAborted();
        const panel = new Panel(inputOptions?.title ?? "Enter private login input", io.color, "warning");
        panel.addChild(new Text(terminalText(label), 0, 1));
        panel.addChild(new Text("1. Paste or type here. Input stays hidden.\n2. Press Enter separately to submit.", 0, 0));
        panel.addChild(new Text(`${inputOptions?.hint ?? "Never enter keys, codes or redirect URLs in chat."}\nEsc cancels`, 0, 1));
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
            if (!(inputOptions?.password ? PASSWORD_TEXT : /^[\x21-\x7e]*$/).test(text) || value.length + text.length > 8192) {
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
            } else if (matchesKey(key, "backspace")) { value = [...value].slice(0, -1).join(""); append(""); }
            else if ((inputOptions?.password ? PASSWORD_TEXT : /^[\x20-\x7e]+$/).test(key) && key.length > 0) append(key);
            // Navigation, history, undo, clipboard and editor commands have no meaning here.
          };
          io.requestRender();
        });
      },
      textInput: async (label, promptSignal, inputOptions) => {
        await fresh();
        const inputSignal = AbortSignal.any([signal, ...(promptSignal ? [promptSignal] : [])]);
        inputSignal.throwIfAborted();
        const panel = new Panel(terminalText(inputOptions?.title ?? "Type it here"), io.color);
        panel.addChild(new Text(terminalText(label), 0, 1));
        const box = new Text("", 0, 0);
        panel.addChild(box);
        const problem = new Text("", 0, 0);
        panel.addChild(problem);
        panel.addChild(new Text(muted(terminalText(`${inputOptions?.hint ? `${inputOptions.hint}\n` : ""}Enter goes on · Esc cancels`)), 0, 1));
        if (note) panel.addChild(new Text(muted(terminalText(note)), 0, 0));
        mount(panel);
        return new Promise<string>((resolve, reject) => {
          let value = inputOptions?.initial ?? "";
          // A suggestion is replaced by the first key typed, kept by Enter, and edited by Backspace.
          let suggested = value.length > 0 && !inputOptions?.editable;
          const show = () => {
            box.setText(`${accent(">")} ${terminalText(value)}${suggested ? muted("  (Enter keeps it, typing replaces it)") : ""}▏`);
            io.requestRender();
          };
          const cleanup = () => { answer = undefined; paste = undefined; inputSignal.removeEventListener("abort", abort); clearPanel(); };
          const abort = () => { cleanup(); reject(new Error("Input cancelled")); };
          const append = (text: string) => {
            const typed = text.replace(/[\r\n]+/g, "");
            if (!VISIBLE_TEXT.test(typed)) return;
            value = (suggested ? "" : value) + typed;
            suggested = false;
            value = value.slice(0, 512);
            problem.setText("");
            show();
          };
          inputSignal.addEventListener("abort", abort, { once: true });
          paste = (text) => append(text.trim());
          answer = (key) => {
            if (inputSignal.aborted) { abort(); return; }
            if (matchesKey(key, "enter")) {
              const why = inputOptions?.check?.(value.trim());
              if (why) { problem.setText(panelColor(terminalText(why), "warning", io.color)); io.requestRender(); return; }
              const result = value.trim(); cleanup(); resolve(result);
            } else if (matchesKey(key, "backspace")) { value = [...value].slice(0, -1).join(""); suggested = false; problem.setText(""); show(); }
            else if (matchesKey(key, "ctrl+u")) { value = ""; suggested = false; problem.setText(""); show(); }
            else if (VISIBLE_TEXT.test(key) && key.length > 0) append(key);
          };
          show();
        });
      },
      wait: (title, text) => {
        if (signal.aborted) return;
        clearPanel();
        const panel = new Panel(terminalText(title), io.color);
        panel.addChild(new Text(`${terminalText(text)}\nEsc cancels`, 0, 1));
        if (note) panel.addChild(new Text(muted(terminalText(note)), 0, 0));
        mount(panel);
      },
      device: (url, code) => {
        if (signal.aborted) return;
        clearPanel();
        // Keep copyable values outside frames: terminal soft-wrap adds no separators.
        write(`${accent("1. Open this URL in your browser:")}\n${terminalText(url)}\n${accent("2. Enter this one-time code:")}\n${terminalText(code)}\n`);
        const panel = new Panel("Approve sign-in in your browser", io.color);
        panel.addChild(new Text("3. Complete the provider's authorization steps.\nWaiting for authorization.", 0, 1));
        panel.addChild(new Text("No browser opens automatically.\nDo not paste credentials here.\nEsc cancels", 0, 0));
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
        panel.addChild(new Text("If the browser is on another machine, paste the final redirect URL in the private prompt.\nCodes and redirect URLs belong only in the private login prompt.\nEsc cancels", 0, 0));
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
