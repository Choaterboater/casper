import { afterAll, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { InteractiveTerminal } from "../src/tui/terminal";
import type { Component } from "@earendil-works/pi-tui";
import type { RuntimePickerView } from "../src/runtime/types";
import { choiceHint, choiceNumber, keyChoice, numberPrompt, PICKER_HINT, typedChoice } from "../src/tui/choices";
import { pickerOptionLines, PickerList } from "../src/tui/picker";
import { Screen } from "./support/conpty";
import { pickEffort } from "../src/tui/effort-picker";
import { richApp } from "./support/app";
import { interactiveTerminal } from "./support/tty";

// The rich-surface path is gated on `TERM !== "dumb"`; the plain test sets it itself.
const ambientTerm = process.env.TERM;
process.env.TERM = "xterm-256color";
afterAll(() => { if (ambientTerm === undefined) delete process.env.TERM; else process.env.TERM = ambientTerm; });

test("every numbered list ends with one hint: the keys, then what else that box takes", () => {
  expect(choiceHint(4, "type to answer", "Esc skip")).toBe(`${PICKER_HINT} · type to answer`);
  for (const count of [1, 4, 24]) expect(choiceHint(count, "Esc is No")).toBe(PICKER_HINT);
  expect(choiceNumber(0, 4)).toBe("1. ");
  expect(choiceNumber(0, 24)).toBe(" 1. ");
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
    await session.screen.until(output => output.includes(PICKER_HINT));
    const visible = Bun.stripANSI(session.screen.output);
    expect(visible).toMatch(/❯ {2}1\. Row 1\b/);
    expect(visible).toContain("12. Row 12");
    expect(visible).toContain(PICKER_HINT);
    session.input.write("1"); // no pick yet: it could be the start of 12
    session.input.write("2\r");
    expect(await answer).toEqual(["Row 12"]);
  } finally { session.close(); }
});

test.each([80, 160])("/effort shares the numbered list and hint at %i columns", async width => {
  let shown: Component | undefined;
  let listener: ((data: string) => unknown) | undefined;
  const view = {
    color: false, onEOF() {}, show(component: Component) { shown = component; },
    tui: { addInputListener(handler: (data: string) => unknown) { listener = handler; return () => {}; }, setFocus() {} },
  } as unknown as RuntimePickerView;
  const picked = pickEffort(view, ["auto", "low", "medium", "high"], "medium");
  const text = shown!.render(width).join("\n");
  expect(text).toMatch(/❯ 3\. medium/);
  expect(text).toContain("1. auto");
  expect(text).toContain(`${PICKER_HINT} · Ctrl+S this session only`);
  listener!("4");
  expect(await picked).toEqual({ level: "high", persist: true });
});

test.each([80, 160])("the shared rows align dim descriptions and keep the accent cursor at %i columns", width => {
  const options = [{ label: "No", description: "nothing runs" }, { label: "Yes, this once", description: "run once" }];
  const rows = options.map((_, index) => pickerOptionLines(options, index, index === 0, width, false).join("\n"));
  expect(rows[0]).toBe("❯ 1. No              nothing runs");
  expect(rows[0]!.indexOf("nothing runs")).toBe(rows[1]!.indexOf("run once"));
  expect(rows[1]).toBe("  2. Yes, this once  run once");
  expect(rows.join("\n")).not.toContain("\x1b");
  const color = pickerOptionLines(options, 0, true, width, true).join("\n");
  expect(color).toContain("❯");
  expect(Bun.stripANSI(color)).toBe(rows[0]!);
  const long = pickerOptionLines([{ label: "full label ".repeat(25), description: "full help ".repeat(25) }], 0, true, width, false);
  expect(long.every(line => line.length <= width)).toBe(true);
  expect(long.join(" ")).toContain("full help");
});

test("the shared list uses arrows and Enter first, with numbers as shortcuts past nine too", () => {
  const list = new PickerList(Array.from({ length: 12 }, (_, index) => ({ value: String(index + 1), label: `Row ${index + 1}` })), false);
  let chosen = "";
  list.onSelect = item => { chosen = item.value; };
  list.handleInput("\x1b[B"); list.handleInput("\r");
  expect(chosen).toBe("2");
  list.handleInput("1"); list.handleInput("2"); list.handleInput("\r");
  expect(chosen).toBe("12");
});

test.each([80, 160])("NO_COLOR approvals have no input row, keep safe order, and show a No note typed on its own row at %i columns", async width => {
  const previous = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
  const session = interactiveTerminal();
  session.screen.writer.columns = width;
  const screen = () => { const view = new Screen(width, 30); view.feed(session.screen.output); return view.text(); };
  const wait = async (check: () => boolean) => {
    for (let i = 0; i < 400 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(check()).toBe(true);
  };
  try {
    session.terminal.start();
    const choices = [{ label: "No", description: "nothing runs" }, { label: "Yes, this once", description: "run once" }];
    const answer = session.terminal.approve("", "Make this change?", choices);
    await wait(() => screen().includes(PICKER_HINT));
    expect(screen()).toContain("❯ 1. No");
    expect(screen()).toContain("  2. Yes, this once");
    expect(screen()).not.toMatch(/^\?\s*$/m);
    expect(session.screen.output).not.toMatch(/\x1b\[(?!0m)[0-9;]*m/);
    session.input.write("\x1b[B");
    await wait(() => screen().includes("❯ 2. Yes, this once"));
    // Letters on the list go nowhere; the note row opens a line, and even the granting label typed there is a note on a No.
    session.input.write("Yes, this once");
    await wait(() => screen().includes("3 to tell the AI what to do instead"));
    expect(screen()).toContain("❯ 2. Yes, this once");
    session.input.write("3");
    session.input.write("Yes, this once");
    await wait(() => screen().includes("❯ 3. No, and tell the AI what to do instead — Yes, this once"));
    expect(screen()).not.toContain("? Yes, this once");
    session.input.write("\r");
    expect(await answer).toBe("No");
    await wait(() => screen().includes("Make this change? → No (Yes, this once)"));
    const safe = session.terminal.approve("", "Try again?", choices);
    await wait(() => screen().includes("Try again?"));
    session.input.write("\r"); expect(await safe).toBe("No");
    const yes = session.terminal.approve("", "Deliberate choice?", choices);
    await wait(() => screen().includes("Deliberate choice?"));
    session.input.write("\x1b[B\r"); expect(await yes).toBe("Yes, this once");
    for (const [question, first, second] of [["Build this plan?", "Stop", "Build"], ["Set up before starting?", "Not now", "Set it up"]]) {
      const picker = session.terminal.pick(question!, [{ label: first! }, { label: second! }]);
      await wait(() => screen().includes(question!));
      expect(screen()).toContain(`❯ 1. ${first}`);
      expect(screen()).not.toMatch(/^\?\s*$/m);
      session.input.write("\r"); expect(await picker).toBe(first!);
    }
    const command = session.terminal.pick("Run this command?  custom-tool build", choices);
    await wait(() => screen().includes("custom-tool build"));
    expect(screen()).toContain("Run this command?");
    session.input.write("3");
    session.input.write("not that command");
    await wait(() => screen().includes("❯ 3. No, and tell the AI what to do instead — not that command"));
    session.input.write("\r"); expect(await command).toBe("No");
    const skipped = session.terminal.approve("", "Skip this?", choices);
    await wait(() => screen().includes("Skip this?"));
    session.input.write("\x1b"); expect(await skipped).toBeUndefined();
  } finally {
    session.close();
    if (previous === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = previous;
  }
});

test.each([80, 160])("plain approvals keep Enter and typed words safe at %i columns", async width => {
  const input = new PassThrough();
  let output = "";
  const terminal = new InteractiveTerminal(input, { isTTY: false, columns: width, write(text: string) { output += text; } } as never, () => {}, () => {});
  terminal.start();
  try {
    const first = terminal.approve("", "Make this change?", ["No", "Yes, this once"]);
    input.write("\n"); expect(await first).toBe("No");
    const words = terminal.approve("", "Try this change?", ["No", "Yes, this once"]);
    input.write("yes please\n"); expect(await words).toBe("No");
    const yes = terminal.approve("", "Explicit choice?", ["No", "Yes, this once"]);
    input.write("2\n"); expect(await yes).toBe("Yes, this once");
    expect(output).toContain("  1 No\n  2 Yes, this once\n");
    expect(output).not.toContain("\x1b");
    expect(output).not.toContain("→ yes please");
  } finally { terminal.close(); input.destroy(); }
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
    const last = /\n {2}(\d\d) Private ssh passwords · Privacy & sign-ins · on\n/.exec(list)?.[1];
    expect(list).not.toContain("Web lookups: on");
    for (const area of ["Tools & browser", "Pages, pictures & diagrams", "Commands & checks", "Models & cost", "Display", "MCP & network", "Privacy & sign-ins"]) expect(list).toContain(area);
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
