import { afterAll, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { buildNextRow } from "../src/tui/next-row";
import { InteractiveTerminal } from "../src/tui/terminal";

const ambientTerm = process.env.TERM;
process.env.TERM = "xterm-256color";
afterAll(() => { if (ambientTerm === undefined) delete process.env.TERM; else process.env.TERM = ambientTerm; });

const undo = { label: "Undo", command: "/undo" };
const diff = { label: "Show diff", command: "/diff" };

test("slots 1 and 2 are Undo and Show diff; other steps start at 3, in plain words", () => {
  const row = buildNextRow({ undo, diff, more: [{ label: "Add a test that proves the fix", command: "/suggestion prove-fix", note: "uses tokens" }] })!;
  expect(row.line).toBe("Next: 1 Undo · 2 Show diff · 3 Add a test that proves the fix (uses tokens)");
  expect([...row.keys]).toEqual([["1", "/undo"], ["2", "/diff"], ["3", "/suggestion prove-fix"]]);
  // Without undo the numbers do not move: the same key always means the same step.
  expect(buildNextRow({ more: [{ label: "Open the page", command: "/pages" }] })!.line).toBe("Next: 3 Open the page");
  expect(buildNextRow({})).toBeUndefined();
  // At most up to 9: one key picks one step.
  expect(buildNextRow({ more: Array.from({ length: 9 }, (_, i) => ({ label: `s${i}`, command: `/s${i}` })) })!.keys.size).toBe(7);
});

test("a step's reason and the hint print under the row, one line each, with the step's number", () => {
  const row = buildNextRow({ more: [{ label: "Remember uv run pytest", command: "/suggestion remember-test", note: "free",
    why: "saves verify.test: uv run pytest\u001b[2J in .casper/project.yaml" }], hint: "A number picks one" })!;
  expect(row.line).toBe("Next: 3 Remember uv run pytest (free)\n  3: saves verify.test: uv run pytest [2J in .casper/project.yaml\n  A number picks one");
});

function plainTerminal() {
  const input = new PassThrough();
  let output = "";
  const writer = Object.assign(new EventEmitter(), { isTTY: false, write(text: string) { output += text; return true; } });
  const terminal = new InteractiveTerminal(input, writer, () => {}, () => {});
  return { input, terminal, get output() { return output; } };
}

test("plain terminal: after the row, a line that is just its number runs that step; anything else is a request", async () => {
  const plain = plainTerminal();
  const { input, terminal } = plain;
  try {
    terminal.start();
    terminal.offerNext(buildNextRow({ undo, diff }));
    expect(plain.output).toBe("Next: 1 Undo · 2 Show diff\n");
    const first = terminal.readCommand();
    input.write("2\n");
    expect(await first).toBe("/diff");
    // The row is used up: the same number next time is an ordinary request.
    const second = terminal.readCommand();
    input.write("2\n");
    expect(await second).toBe("2");
    terminal.offerNext(buildNextRow({ undo, diff }));
    const third = terminal.readCommand();
    input.write("fix the other test too\n");
    expect(await third).toBe("fix the other test too");
  } finally { terminal.close(); input.destroy(); }
});

test("plain terminal: a line typed before the row appeared never picks from it", async () => {
  const { input, terminal } = plainTerminal();
  try {
    terminal.start();
    // Typed ahead while Casper was still starting: queued as a request.
    input.write("1\n");
    await new Promise((resolve) => setImmediate(resolve));
    terminal.offerNext(buildNextRow({ undo, diff }));
    expect(await terminal.readCommand()).toBe("1");
  } finally { terminal.close(); input.destroy(); }
});

function richTerminal() {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  let output = "";
  let pending: { test: (text: string) => boolean; resolve: () => void } | undefined;
  const writer = Object.assign(new EventEmitter(), { isTTY: true, columns: 80, rows: 24, write(text: string) {
    output += text;
    if (pending?.test(output)) { pending.resolve(); pending = undefined; }
  } });
  const terminal = new InteractiveTerminal(input, writer, () => {}, () => {});
  const until = (test: (text: string) => boolean) => {
    if (test(output)) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    pending = { test, resolve };
    return promise;
  };
  return { input, terminal, until };
}

test("rich terminal: one key on the empty prompt runs the step; any other key first clears the row", async () => {
  const { input, terminal, until } = richTerminal();
  try {
    terminal.start();
    terminal.offerNext(buildNextRow({ undo, diff }));
    await until((text) => Bun.stripANSI(text).includes("Next: 1 Undo · 2 Show diff"));
    const first = terminal.readCommand();
    input.write("1");
    expect(await first).toBe("/undo");

    terminal.offerNext(buildNextRow({ undo, diff }));
    const second = terminal.readCommand();
    // Typing starts a request: the digits are text now, not picks.
    input.write("x");
    input.write("2");
    input.write("\r");
    expect(await second).toBe("x2");

    // Starting to type and then erasing it still used up the row: the number on the empty prompt is text.
    terminal.offerNext(buildNextRow({ undo, diff }));
    const third = terminal.readCommand();
    input.write("x");
    input.write("\x7f");
    input.write("2");
    input.write("\r");
    expect(await third).toBe("2");
  } finally { terminal.close(); input.destroy(); }
});

test("rich terminal: the row never answers a question that is open", async () => {
  const { input, terminal, until } = richTerminal();
  try {
    terminal.start();
    terminal.offerNext(buildNextRow({ undo, diff }));
    const answer = terminal.ask("Which one?", [{ label: "Keep it" }, { label: "Drop it" }], false);
    await until((text) => Bun.stripANSI(text).includes("Drop it"));
    input.write("2");
    input.write("\r");
    expect(await answer).toEqual(["Drop it"]);
  } finally { terminal.close(); input.destroy(); }
});

test("rich terminal: Enter on the empty prompt never picks from the row (not even Undo in slot 1)", async () => {
  const { input, terminal, until } = richTerminal();
  try {
    terminal.start();
    terminal.offerNext(buildNextRow({ undo, diff }));
    await until((text) => Bun.stripANSI(text).includes("Next: 1 Undo · 2 Show diff"));
    const first = terminal.readCommand();
    input.write("\r");
    input.write("x");
    input.write("\r");
    // Enter on an empty prompt submits nothing; the row is gone, so the next line is just a request.
    expect(await first).toBe("x");
  } finally { terminal.close(); input.destroy(); }
});

test("plain terminal: an empty line after the row runs nothing, and uses the row up", async () => {
  const { input, terminal } = plainTerminal();
  try {
    terminal.start();
    terminal.offerNext(buildNextRow({ undo, diff }));
    const first = terminal.readCommand();
    input.write("\n");
    expect(await first).toBe("");
    const second = terminal.readCommand();
    input.write("1\n");
    expect(await second).toBe("1");
  } finally { terminal.close(); input.destroy(); }
});
