import { afterAll, expect, test } from "bun:test";
import { askDefaults } from "../src/tui/surface";
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
    await session.screen.until((output) => output.includes("Make this change?") && output.includes("3 Yes, for this session"));
    expect(Bun.stripANSI(session.screen.output)).toContain("port  1/1/1");
    session.input.write("2");
    expect(await answer).toBe("Yes, this once");
  } finally { session.close(); }
});

test("typed words in an approval box are a No, and ctrl+o denies an open one", async () => {
  const session = interactiveTerminal();
  try {
    session.terminal.setStatus("fixture"); session.terminal.start();
    const typed = session.terminal.approve("", "Make this change?", ["No", "Yes, this once"]);
    await session.screen.until((output) => output.includes("Make this change?"));
    session.input.write("yes please\r");
    expect(await typed).toBe("No");
    // The answered box is the only record, so it shows the No the words meant, not the words.
    await session.screen.until((output) => Bun.stripANSI(output).includes("✓ No"));
    expect(Bun.stripANSI(session.screen.output)).not.toContain("→ yes please");
    session.terminal.setWritesRevert(() => true);
    const open = session.terminal.approve("", "Make this other change?", ["No", "Yes, this once"]);
    await session.screen.until((output) => output.includes("Make this other change?"));
    session.input.write("\x0f");
    expect(await open).toBeUndefined();
  } finally { session.close(); }
});
