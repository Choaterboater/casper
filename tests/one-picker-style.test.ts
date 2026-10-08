import { afterAll, expect, test } from "bun:test";
import type { Component } from "@earendil-works/pi-tui";
import type { RuntimePickerView } from "../src/runtime/types";
import { choiceHint, keyChoice, numberPrompt, typedChoice } from "../src/tui/choices";
import { pickEffort } from "../src/tui/effort-picker";
import { richApp } from "./support/app";
import { interactiveTerminal } from "./support/tty";

// The rich-surface path is gated on `TERM !== "dumb"`; the plain test sets it itself.
const ambientTerm = process.env.TERM;
process.env.TERM = "xterm-256color";
afterAll(() => { if (ambientTerm === undefined) delete process.env.TERM; else process.env.TERM = ambientTerm; });

test("every numbered list ends with one hint: the keys, then what else that box takes", () => {
  expect(choiceHint(4, "type to answer", "Esc skip")).toBe("Press 1-4 or Up/Down + Enter · type to answer · Esc skip");
  expect(choiceHint(4, "Esc is No")).toBe("Press 1-4 or Up/Down + Enter · Esc is No");
  expect(choiceHint(1, "Esc cancels")).toBe("Press 1 or Enter · Esc cancels");
  expect(choiceHint(24, "Esc skip")).toBe("Type 1-24 + Enter or Up/Down + Enter · Esc skip");
  expect(numberPrompt(3)).toBe("Type 1, 2 or 3: ");
  expect(numberPrompt(24)).toBe("Type 1-24: ");
  // A digit picks at once only while every row has one; past nine the number is typed and sent.
  expect([keyChoice("3", 4), keyChoice("5", 4), keyChoice("1", 24)]).toEqual([2, -1, -1]);
  expect([typedChoice("12", 24), typedChoice("12", 4), typedChoice("25", 24), typedChoice("12 rows", 24)]).toEqual([11, -1, -1, -1]);
});

test("a question past nine choices numbers every row; a row's number typed and sent picks it", async () => {
  const session = interactiveTerminal();
  const options = Array.from({ length: 23 }, (_, index) => ({ label: `Row ${index + 1}` }));
  try {
    session.terminal.setStatus("fixture"); session.terminal.start();
    const answer = session.terminal.ask("Pick one to change:", options, false);
    await session.screen.until(output => output.includes("Type 1-23 + Enter"));
    const visible = Bun.stripANSI(session.screen.output);
    expect(visible).toMatch(/→ {2}1 Row 1\b/);
    expect(visible).toContain("  12 Row 12");
    expect(visible).toContain("  23 Row 23");
    expect(visible).toContain("Type 1-23 + Enter or Up/Down + Enter · type to answer · Esc skip");
    session.input.write("1"); // no pick yet: it could be the start of 12
    session.input.write("2\r");
    expect(await answer).toEqual(["Row 12"]);
  } finally { session.close(); }
});

test("/effort's picker is the same numbered list: a level's number picks and remembers it", async () => {
  let shown: Component | undefined;
  let listener: ((data: string) => unknown) | undefined;
  const view = {
    color: false, onEOF() {}, show(component: Component) { shown = component; },
    tui: { addInputListener(handler: (data: string) => unknown) { listener = handler; return () => {}; }, setFocus() {} },
  } as unknown as RuntimePickerView;
  const picked = pickEffort(view, ["auto", "low", "medium", "high"], "medium");
  const text = shown!.render(80).join("\n");
  expect(text).toMatch(/→ 3 medium/);
  expect(text).toContain("1 auto");
  expect(text).toContain("Press 1-4 or Up/Down + Enter · Ctrl+S this session only · Esc cancels");
  listener!("4");
  expect(await picked).toEqual({ level: "high", persist: true });
});

test("/settings on a plain terminal (TERM=dumb) is a numbered list that reads a number; nothing goes to the model", async () => {
  process.env.TERM = "dumb";
  let prompts = 0;
  const f = await richApp(project => ({
    start: async () => ({
      getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" as const }),
      getState: () => ({ cwd: project, isStreaming: false }),
      setTools: () => {}, subscribe: () => () => {}, abort: async () => {},
      prompt: async () => { prompts++; },
    }),
    dispose: async () => {},
  }) as never);
  try {
    await f.until(screen => screen.includes("> "));
    f.input.write("/settings\r");
    await f.until(screen => /Type 1-\d\d: $/.test(screen));
    const list = f.screen();
    expect(list).toContain("Pick one to change:");
    expect(list).toContain("  1 Done · nothing changes");
    const last = /\n {2}(\d\d) Private ssh passwords · on\n/.exec(list)?.[1];
    expect(last).toBeDefined();
    // The last row is reachable by its number: its question, then 1 keeps it.
    f.input.write(`${last}\r`);
    await f.until(screen => screen.includes("Casper shows its own hidden box") && screen.endsWith("Type 1 or 2: "));
    const before = f.screen().length;
    f.input.write("1\r");
    await f.until(screen => screen.length > before && /Type 1-\d\d: $/.test(screen));
    f.input.write("1\r");
    await f.until(screen => screen.endsWith("> "));
    expect(prompts).toBe(0);
    expect(f.screen()).not.toContain("[settings]");
  } finally {
    f.input.end();
    await f.interactive;
    await f.close();
    process.env.TERM = "xterm-256color";
  }
}, 30_000);
