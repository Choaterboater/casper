import { afterAll, expect, test } from "bun:test";
import { askDefaults, printableKey } from "../src/tui/surface";
import { interactiveTerminal } from "./support/tty";

/**
 * Every box takes one input style: the numbered panel, where one key picks (or Up/Down and Enter). Approval boxes
 * use it too. Keys pressed in the first moment after a box opens (typed mid-sentence) are ignored, so they never
 * answer it.
 */

const ambientTerm = process.env.TERM;
process.env.TERM = "xterm-256color";
afterAll(() => { if (ambientTerm === undefined) delete process.env.TERM; else process.env.TERM = ambientTerm; });

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const pending = Symbol("pending");
const state = <T>(promise: Promise<T>) => Promise.race([promise, settle(30).then(() => pending)]);

test("keys pressed just after a box opens are ignored; a key a moment later picks", async () => {
  const before = askDefaults.guardMs;
  askDefaults.guardMs = 300;
  const session = interactiveTerminal();
  try {
    session.terminal.setStatus("fixture"); session.terminal.start();
    const answer = session.terminal.pick("Reach build-server?", [{ label: "No" }, { label: "Yes, this once" }]);
    await session.screen.until((output) => output.includes("Reach build-server?"));
    session.input.write("2");
    session.input.write("\r");
    expect(await state(answer)).toBe(pending);
    await settle(320);
    session.input.write("2");
    expect(await answer).toBe("Yes, this once");
  } finally { askDefaults.guardMs = before; session.close(); }
});

test("an approval box is the numbered panel: one key answers it, no Enter", async () => {
  const session = interactiveTerminal();
  try {
    session.terminal.setStatus("fixture"); session.terminal.start();
    const answer = session.terminal.approve("Change in Central: set the port\n  port  1/1/1\n", "Make this change?", ["No", "Yes, this once", "Yes, for this session"]);
    await session.screen.until((output) => output.includes("Make this change?") && output.includes("3. Yes, for this session"));
    expect(Bun.stripANSI(session.screen.output)).toContain("port  1/1/1");
    session.input.write("2");
    expect(await answer).toBe("Yes, this once");
  } finally { session.close(); }
});

test("letters typed in an approval box go nowhere: they never answer it, and a hint names the keys and the note row", async () => {
  const session = interactiveTerminal();
  try {
    session.terminal.setStatus("fixture"); session.terminal.start();
    const typed = session.terminal.approve("", "Make this change?", ["No", "Yes, this once"]);
    await session.screen.until((output) => output.includes("3. No, and tell the AI what to do instead"));
    // "go" meant yes: it is not typed into a field, the highlight doesn't move, and the box stays open.
    session.input.write("go");
    await session.screen.until((output) => Bun.stripANSI(output).includes("Pick with 1-3 or ↑↓ Enter · 3 to tell the AI what to do instead"));
    expect(Bun.stripANSI(session.screen.output)).not.toContain("— go");
    // The number keys work at once: no Backspace needed.
    session.input.write("2");
    expect(await typed).toBe("Yes, this once");
  } finally { session.close(); }
});

test("the note row opens a line: Enter sends No with the note, Esc goes back to the list, and Ctrl+X denies an open box", async () => {
  const session = interactiveTerminal();
  try {
    session.terminal.setStatus("fixture"); session.terminal.start();
    const noted = session.terminal.approve("", "Make this change?", ["No", "Yes, this once"]);
    await session.screen.until((output) => output.includes("3. No, and tell the AI what to do instead"));
    session.input.write("3");
    await session.screen.until((output) => Bun.stripANSI(output).includes("Enter to send No with this note · Esc to go back"));
    // Words that spell a granting label are still a note on a No.
    session.input.write("yes please");
    await session.screen.until((output) => Bun.stripANSI(output).includes("No, and tell the AI what to do instead — yes please"));
    session.input.write("\r");
    expect(await noted).toBe("No");
    await session.screen.until((output) => Bun.stripANSI(output).includes("Make this change? → No (yes please)"));

    // Esc on the line goes back to the list, its words gone; Enter on the list is No.
    const back = session.terminal.approve("", "Make this second change?", ["No", "Yes, this once"]);
    await session.screen.until((output) => output.includes("Make this second change?"));
    session.input.write("3");
    await session.screen.until((output) => Bun.stripANSI(output).split("Make this second change?").at(-1)!.includes("Esc to go back"));
    session.input.write("use bun");
    await session.screen.until((output) => Bun.stripANSI(output).includes("what to do instead — use bun"));
    session.input.write("\x1b");
    await session.screen.until((output) => Bun.stripANSI(output).split("Make this second change?").at(-1)!.includes("Enter to choose · Esc to skip"));
    session.input.write("\x1b[A\x1b[A\r");
    expect(await back).toBe("No");
    await session.screen.until((output) => Bun.stripANSI(output).includes("Make this second change? → No"));
    expect(Bun.stripANSI(session.screen.output)).not.toContain("Make this second change? → No (use bun)");

    session.terminal.setWritesRevert(() => true);
    const open = session.terminal.approve("", "Make this other change?", ["No", "Yes, this once"]);
    await session.screen.until((output) => output.includes("Make this other change?"));
    session.input.write("\x18");
    expect(await open).toBeUndefined();
  } finally { session.close(); }
});

test("keys a terminal sends as escape codes (kitty keypad digits, Shift+letters) follow the same rules: a digit picks, a letter goes nowhere", async () => {
  const session = interactiveTerminal();
  try {
    session.terminal.setStatus("fixture"); session.terminal.start();
    const answer = session.terminal.approve("", "Run this tool?", ["No", "Yes", "Yes to everything this session"]);
    await session.screen.until((output) => output.includes("4. No, and tell the AI what to do instead"));
    // Shift+G as kitty and as modifyOtherKeys send: nothing is typed, and the hint shows.
    session.input.write("\x1b[71;2u");
    session.input.write("\x1b[27;2;71~");
    await session.screen.until((output) => Bun.stripANSI(output).includes("Pick with 1-4 or ↑↓ Enter · 4 to tell the AI what to do instead"));
    expect(Bun.stripANSI(session.screen.output)).not.toContain("Number:");
    // The keypad's 2 (kitty KP_2) picks row 2 at once.
    session.input.write("\x1b[57401u");
    expect(await answer).toBe("Yes");
  } finally { session.close(); }
});

test("a keypad key that types nothing (kitty's keypad Enter) is not taken as a letter", () => {
  expect(printableKey("\x1b[57414u")).toBeUndefined();
  expect(printableKey("\x1b[57401u")).toBe("2");
  expect(printableKey("\x1b[27;2;71~")).toBe("G");
  expect(printableKey("\x1b[13u")).toBeUndefined();
});
