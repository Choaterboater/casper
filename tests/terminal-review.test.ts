import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { InteractiveTerminal } from "../src/tui/terminal";

function terminalFixture() {
  const input = new PassThrough();
  let output = "";
  const terminal = new InteractiveTerminal(input, { write: (text) => { output += text; } }, () => {}, () => {});
  terminal.start();
  return { input, terminal, output: () => output };
}

test("redirected interactive input cannot reuse a pretyped yes for a later approval", async () => {
  const { input, terminal } = terminalFixture();
  try {
    const command = terminal.readCommand();
    input.write("task\n");
    expect(await command).toBe("task");
    input.write("yes");
    const approval = terminal.confirm("Exact operation\n", "Type yes: ");
    input.write("\n");
    expect(await approval).toBe(false);
    const fresh = terminal.confirm("Another exact operation\n", "Type yes: ");
    input.write("yes\n");
    expect(await fresh).toBe(true);
  } finally { terminal.close(); input.destroy(); }
});

test("cooked TTY input with redirected output cannot authorize an unseen pretyped answer", async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true });
  let output = "";
  const terminal = new InteractiveTerminal(input, { write: (text) => { output += text; } }, () => {}, () => {});
  terminal.start();
  try {
    const command = terminal.readCommand(); input.write("task\n"); await command;
    const approval = terminal.confirm("Exact operation\n", "Type yes: ");
    // A cooked terminal can deliver a whole pretyped line only after the
    // confirmation appears, so flushing readline alone cannot establish freshness.
    input.write("yes\n");
    expect(await approval).toBe(false);
    expect(output).toContain("approval denied");
  } finally { terminal.close(); input.destroy(); }
});

test("aborting plain confirmation discards its partial answer before accepting another command", async () => {
  const { input, terminal } = terminalFixture();
  try {
    const command = terminal.readCommand(); input.write("task\n"); await command;
    const controller = new AbortController();
    const approval = terminal.confirm("Exact operation\n", "Type yes: ", controller.signal);
    input.write("ye"); controller.abort();
    expect(await approval).toBe(false);
    const next = terminal.readCommand(); input.write("/status\n");
    expect(await next).toBe("/status");
  } finally { terminal.close(); input.destroy(); }
});

test("plain redirected output still streams incomplete assistant text before completion", () => {
  const { input, terminal, output } = terminalFixture();
  try {
    terminal.assistant("Hello");
    expect(output()).toContain("Hello");
    terminal.assistant(" world\n");
    terminal.endAssistant();
    expect(output()).toBe("Hello world\n");
  } finally { terminal.close(); input.destroy(); }
});
