import { expect, test } from "bun:test";
import { FOCUS_OFF, FOCUS_ON } from "../src/tui/stream-terminal";
import { interactiveTerminal } from "./support/tty";

process.env.TERM = "xterm-256color";
// OSC sequences (window title, links) end with BEL too; only a bare BEL is the bell.
const bells = (output: string) => output.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").split("\x07").length - 1;

test("a task that ran longer than the threshold rings once when it finishes; a quick one does not", async () => {
  const session = interactiveTerminal();
  try {
    session.terminal.setStatus("fixture"); session.terminal.start();
    session.terminal.setAttentionAfter(0);
    const first = session.terminal.readCommand();
    session.input.write("do it\r");
    expect(await first).toBe("do it");
    await Bun.sleep(5);
    const next = session.terminal.readCommand();
    expect(bells(session.screen.output)).toBe(1);
    session.terminal.setAttentionAfter(60_000);
    session.input.write("again\r");
    await next;
    void session.terminal.readCommand();
    expect(bells(session.screen.output)).toBe(1);
  } finally { session.close(); }
});

test("a question during a long task rings", async () => {
  const session = interactiveTerminal();
  try {
    session.terminal.setStatus("fixture"); session.terminal.start();
    session.terminal.setAttentionAfter(0);
    const command = session.terminal.readCommand();
    session.input.write("do it\r");
    await command;
    await Bun.sleep(5);
    const answer = session.terminal.ask("Which one?", [{ label: "A" }, { label: "B" }], false);
    await session.screen.until(output => output.includes("Which one?"));
    expect(bells(session.screen.output)).toBe(1);
    session.input.write("1");
    await answer;
  } finally { session.close(); }
});

test("focus reports: no bell while the terminal is in front, a bell once it is behind, and the reports never reach the prompt", async () => {
  const session = interactiveTerminal();
  try {
    session.terminal.setStatus("fixture"); session.terminal.start();
    expect(session.screen.output).toContain(FOCUS_ON);
    session.terminal.setAttentionAfter(0);
    session.input.write("\x1b[I");
    const first = session.terminal.readCommand();
    session.input.write("do it\r");
    expect(await first).toBe("do it");
    await Bun.sleep(5);
    const second = session.terminal.readCommand();
    expect(bells(session.screen.output)).toBe(0);
    session.input.write("\x1b[O");
    session.input.write("again\r");
    // The focus reports typed nothing: the line is exactly what was typed.
    expect(await second).toBe("again");
    await Bun.sleep(5);
    void session.terminal.readCommand();
    expect(bells(session.screen.output)).toBe(1);
  } finally { session.close(); }
  expect(session.screen.output.lastIndexOf(FOCUS_OFF)).toBeGreaterThan(session.screen.output.lastIndexOf(FOCUS_ON));
});

test("notifications off: nothing rings, focus or not", async () => {
  const session = interactiveTerminal();
  try {
    session.terminal.setStatus("fixture"); session.terminal.start();
    session.terminal.setAttentionAfter(0);
    session.terminal.setNotifications(() => false);
    const first = session.terminal.readCommand();
    session.input.write("do it\r");
    await first;
    await Bun.sleep(5);
    void session.terminal.readCommand();
    expect(bells(session.screen.output)).toBe(0);
  } finally { session.close(); }
});
