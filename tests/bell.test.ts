import { expect, test } from "bun:test";
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
