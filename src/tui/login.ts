import { StdinBuffer, matchesKey } from "@earendil-works/pi-tui";
import type { RuntimePickerIO } from "../runtime/types";
import { terminalText } from "./format";

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
  let inputBytes = 0;
  const write = (text: string) => { if (!closed && !signal.aborted) io.output.write(text); };
  const cancel = () => { controller.abort(); answer?.(""); };
  const eof = () => { cancel(); io.onEOF(); };
  const bind = () => {
    buffer.on("data", (key) => {
      if (matchesKey(key, "ctrl+d")) { eof(); return; }
      if (matchesKey(key, "escape") || matchesKey(key, "ctrl+c")) { cancel(); return; }
      // A multi-key chunk may enter private text but cannot submit it or grant consent.
      if (singleKey || (paste && !matchesKey(key, "enter"))) answer?.(key);
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
    answer = undefined; paste = undefined; inputBytes = 0;
    buffer.destroy(); buffer = new StdinBuffer(); bind();
    // Never reuse keys or partial escape/paste state from the preceding step.
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const ask = async <V>(text: string, accept: (key: string) => V | undefined): Promise<V | undefined> => {
    await fresh();
    if (signal.aborted) return undefined;
    return new Promise((resolve) => {
      answer = (key) => {
        const result = signal.aborted ? undefined : accept(key);
        if (result === undefined && !signal.aborted) return;
        answer = undefined; resolve(result);
      };
      write(text);
    });
  };
  signal.addEventListener("abort", cancel, { once: true });
  io.input.on("data", data); io.input.once("end", eof); io.input.once("close", eof);
  io.input.setRawMode?.(true); io.input.resume();
  try {
    write("\x1b[?2004h");
    return await work({ signal,
      choose: async (title, items) => {
        let selected = 0;
        const choice = await ask(`[login] ${title}\n${items.map((item, index) => `${index === 0 ? ">" : " "} ${item.label}`).join("\n")}\n  Cancel\nUp/Down selects; Enter confirms; Esc cancels.\n`, (key) => {
          if (matchesKey(key, "down") || matchesKey(key, "up")) {
            selected = (selected + (matchesKey(key, "down") ? 1 : items.length) + items.length + 1) % (items.length + 1);
            write(`Selected: ${items[selected]?.label ?? "Cancel"}\n`); return;
          }
          if (matchesKey(key, "enter")) return selected;
        });
        return choice === undefined ? undefined : items[choice]?.id;
      },
      consent: async (destination, provider, method, disclosure) => (await ask(`[login] Sign in to ${provider} using ${method}?\nSuccessful login will save or replace only the ${provider} credential at:\n${terminalText(destination)}\nThis store is shared with Pi and Casper parent/child/learning runtimes.\n${disclosure}\nModel choices and defaults will not change. No browser opens automatically.\nPress Y to consent, or Esc/Ctrl-C to cancel.\n`, (key) => key === "y" || key === "Y" ? true : undefined)) === true,
      privateInput: async (label, promptSignal) => {
        await fresh();
        const inputSignal = AbortSignal.any([signal, ...(promptSignal ? [promptSignal] : [])]);
        inputSignal.throwIfAborted();
        return new Promise<string>((resolve, reject) => {
          let value = "";
          const cleanup = () => { value = ""; answer = undefined; paste = undefined; inputSignal.removeEventListener("abort", abort); };
          const abort = () => { cleanup(); reject(new Error("Login input cancelled")); };
          const append = (text: string) => {
            // Keys and redirects are printable ASCII. Reject rather than strip controls/newlines.
            if (!/^[\x21-\x7e]*$/.test(text) || value.length + text.length > 8192) {
              cleanup(); reject(new Error("Invalid private input")); return;
            }
            value += text;
            write("\r\x1b[2KPrivate input: " + (value ? "[hidden]" : "[empty]"));
          };
          inputSignal.addEventListener("abort", abort, { once: true });
          paste = append;
          answer = (key) => {
            if (inputSignal.aborted) { abort(); return; }
            if (matchesKey(key, "enter")) {
              if (!value) return;
              const result = value; cleanup(); write("\nPrivate input received.\n"); resolve(result);
            } else if (matchesKey(key, "backspace")) { value = value.slice(0, -1); append(""); }
            else if (/^[\x20-\x7e]+$/.test(key)) append(key);
            // Navigation, history, undo, clipboard and editor commands have no meaning here.
          };
          write(`${label}\nPaste/type privately; Enter submits; Esc/Ctrl-C cancels.\nPrivate input: [empty]`);
        });
      },
      device: (url, code) => write(`Open this URL yourself: ${url}\nOne-time code: ${code}\nWaiting for authorization. Esc/Ctrl-C cancels. Do not paste credentials here.\n`),
      browser: (url) => write(`Open this URL yourself:\n${url}\nWaiting for browser authorization. No browser opens automatically.\n`),
    });
  } finally {
    closed = true;
    signal.removeEventListener("abort", cancel);
    controller.abort(); answer = undefined; paste = undefined; buffer.destroy();
    await new Promise<void>((resolve) => setImmediate(resolve));
    io.input.off("data", data); io.input.off("end", eof); io.input.off("close", eof);
    io.input.pause();
    io.output.write("\x1b[?2004l"); io.input.setRawMode?.(wasRaw);
  }
}
