import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { InteractiveTerminal } from "../../src/tui/terminal";

/** Fake TTY writer whose `until` resolves on the first write that satisfies the predicate, no timers. */
export function fakeWriter() {
  let output = "";
  let pending: { test: (output: string) => boolean; resolve: () => void } | undefined;
  const writer = Object.assign(new EventEmitter(), { isTTY: true, columns: 100, rows: 30, write(text: string) {
    output += text;
    if (pending?.test(Bun.stripANSI(output))) { pending.resolve(); pending = undefined; }
  } });
  return {
    writer,
    get output() { return output; },
    until(test: (output: string) => boolean): Promise<void> {
      if (test(Bun.stripANSI(output))) return Promise.resolve();
      const { promise, resolve } = Promise.withResolvers<void>();
      pending = { test, resolve };
      return promise;
    },
  };
}

/** A rich InteractiveTerminal over a fake TTY. Callers set TERM to a non-dumb value first. */
export function interactiveTerminal() {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const screen = fakeWriter();
  const terminal = new InteractiveTerminal(input, screen.writer, () => {}, () => {});
  return { input, terminal, screen, close: () => { terminal.close(); input.destroy(); } };
}
