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
    const approval = terminal.approve("Exact operation\n", "Do it?", ["No", "Yes"]).then((answer) => answer === "Yes");
    input.write("\n");
    expect(await approval).toBe(false);
    const fresh = terminal.approve("Another exact operation\n", "Do it?", ["No", "Yes"]).then((answer) => answer === "Yes");
    input.write("2\n");
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
    const approval = terminal.approve("Exact operation\n", "Do it?", ["No", "Yes"]).then((answer) => answer === "Yes");
    // A cooked terminal can deliver a whole pretyped line only after the
    // confirmation appears, so flushing readline alone cannot establish freshness.
    input.write("2\n");
    expect(await approval).toBe(false);
  } finally { terminal.close(); input.destroy(); }
});

test("aborting plain confirmation discards its partial answer before accepting another command", async () => {
  const { input, terminal } = terminalFixture();
  try {
    const command = terminal.readCommand(); input.write("task\n"); await command;
    const controller = new AbortController();
    const approval = terminal.approve("Exact operation\n", "Do it?", ["No", "Yes"], controller.signal).then((answer) => answer === "Yes");
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

test("lines piped ahead of an approval are discarded, never answering it or becoming later prompts", async () => {
  const { input, terminal } = terminalFixture();
  try {
    const command = terminal.readCommand();
    input.write("/branch x\nyes\nsecond prompt\n");
    expect(await command).toBe("/branch x");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const approval = terminal.approve("Exact operation\n", "Do it?", ["No", "Yes"]).then((answer) => answer === "Yes");
    input.end();
    expect(await approval).toBe(false);
    expect(await terminal.readCommand()).toBeUndefined();
  } finally { terminal.close(); input.destroy(); }
});

test("plain approve picks by number or by name; Enter alone and any other text are No", async () => {
  const { input, terminal, output } = terminalFixture();
  try {
    const command = terminal.readCommand(); input.write("task\n"); await command;
    const byNumber = terminal.approve("Box\n", "Make this change?", ["No", "Preview first", "Yes, this once"]);
    input.write(" 2 \n");
    expect(await byNumber).toBe("Preview first");
    const other = terminal.approve("Box\n", "Make this change?", ["No", "Yes, this once"]);
    input.write("p\n");
    expect(await other).toBe("No");
    const enter = terminal.approve("Box\n", "Make this change?", ["No", "Yes, this once"]);
    input.write("\n");
    expect(await enter).toBe("No");
    const named = terminal.approve("Box\n", "Make this change?", ["No", "Yes, this once"]);
    input.write("yes, this once\n");
    expect(await named).toBe("Yes, this once");
    expect(output()).toContain("Make this change?\n  1 No\n  2 Yes, this once\n");
  } finally { terminal.close(); input.destroy(); }
});

test("plain approve resolves undefined on abort or end of input, never an answer", async () => {
  const { input, terminal } = terminalFixture();
  try {
    const command = terminal.readCommand(); input.write("task\n"); await command;
    const controller = new AbortController();
    const aborted = terminal.approve("Box\n", "Make this change?", ["No", "Yes, this once"], controller.signal);
    controller.abort();
    expect(await aborted).toBeUndefined();
    const ended = terminal.approve("Box\n", "Make this change?", ["No", "Yes, this once"]);
    input.end();
    expect(await ended).toBeUndefined();
  } finally { terminal.close(); input.destroy(); }
});

test("rich approve: a pretyped draft never answers, one key picks, Esc is no answer", async () => {
  const previousTerm = process.env.TERM;
  process.env.TERM = "xterm-256color";
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const terminal = new InteractiveTerminal(input, { isTTY: true, columns: 80, rows: 24, write: () => {} }, () => {}, () => {});
  const tick = () => new Promise(resolve => setTimeout(resolve, 60));
  try {
    terminal.setStatus("fixture"); terminal.start();
    const pending = terminal.readCommand();
    input.write("work\r");
    expect(await pending).toBe("work");
    await tick();
    input.write("2"); await tick();
    const first = terminal.approve("Box\n", "Make this change?", ["No", "Preview first", "Yes, this once"]);
    input.write("\r");
    expect(await first).toBe("No");
    const second = terminal.approve("Box\n", "Make this change?", ["No", "Preview first", "Yes, this once"]);
    await tick();
    input.write("2");
    expect(await second).toBe("Preview first");
    const third = terminal.approve("Box\n", "Make this change?", ["No", "Yes, this once"]);
    await tick();
    input.write("\x1b"); await tick();
    expect(await third).toBeUndefined();
  } finally {
    terminal.close(); input.destroy();
    if (previousTerm === undefined) delete process.env.TERM; else process.env.TERM = previousTerm;
  }
});

test("the model's ask tool cannot open or answer an open approval", async () => {
  const previousTerm = process.env.TERM;
  process.env.TERM = "xterm-256color";
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const terminal = new InteractiveTerminal(input, { isTTY: true, columns: 80, rows: 24, write: () => {} }, () => {}, () => {});
  const tick = () => new Promise(resolve => setTimeout(resolve, 60));
  try {
    terminal.setStatus("fixture"); terminal.start();
    const pending = terminal.readCommand();
    input.write("work\r");
    expect(await pending).toBe("work");
    let settled: string | undefined = "open";
    const approval = terminal.approve("Box\n", "Make this change?", ["No", "Yes, this once"]).then((answer) => { settled = answer; return answer; });
    await tick();
    // The ask tool gets nothing while the approval is open, and its answer never reaches the approval.
    expect(await terminal.ask("Enable writes?", [{ label: "yes" }], false)).toBeUndefined();
    await tick();
    expect(settled).toBe("open");
    input.write("2");
    expect(await approval).toBe("Yes, this once");
  } finally {
    terminal.close(); input.destroy();
    if (previousTerm === undefined) delete process.env.TERM; else process.env.TERM = previousTerm;
  }
});
