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

test("lines piped ahead of an approval are discarded, never answering it or becoming later prompts", async () => {
  const { input, terminal } = terminalFixture();
  try {
    const command = terminal.readCommand();
    input.write("/branch x\nyes\nsecond prompt\n");
    expect(await command).toBe("/branch x");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const approval = terminal.confirm("Exact operation\n", "Type yes: ");
    input.end();
    expect(await approval).toBe(false);
    expect(await terminal.readCommand()).toBeUndefined();
  } finally { terminal.close(); input.destroy(); }
});

test("plain choose resolves an offered answer, and 'no' for any other text", async () => {
  const { input, terminal, output } = terminalFixture();
  try {
    const command = terminal.readCommand(); input.write("task\n"); await command;
    const preview = terminal.choose("Box\n", "Run it? Type yes, or p to preview first: ", ["yes", "p"]);
    input.write(" p \n");
    expect(await preview).toBe("p");
    const other = terminal.choose("Box\n", "Run it? Type yes: ", ["yes"]);
    input.write("p\n");
    expect(await other).toBe("no");
    const yes = terminal.choose("Box\n", "Run it? Type yes: ", ["yes"]);
    input.write("yes\n");
    expect(await yes).toBe("yes");
    expect(output()).toContain("Run it? Type yes, or p to preview first: ");
  } finally { terminal.close(); input.destroy(); }
});

test("plain choose resolves undefined on abort or end of input, never an answer", async () => {
  const { input, terminal } = terminalFixture();
  try {
    const command = terminal.readCommand(); input.write("task\n"); await command;
    const controller = new AbortController();
    const aborted = terminal.choose("Box\n", "Run it? Type yes: ", ["yes"], controller.signal);
    controller.abort();
    expect(await aborted).toBeUndefined();
    const ended = terminal.choose("Box\n", "Run it? Type yes: ", ["yes"]);
    input.end();
    expect(await ended).toBeUndefined();
  } finally { terminal.close(); input.destroy(); }
});

test("rich choose resolves 'p' when offered, and a pretyped draft 'p' never answers", async () => {
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
    input.write("p"); await tick();
    const first = terminal.choose("Box\n", "Run it? Type yes, or p to preview first: ", ["yes", "p"]);
    input.write("\r");
    expect(await first).toBe("no");
    const second = terminal.choose("Box\n", "Run it? Type yes, or p to preview first: ", ["yes", "p"]);
    await tick();
    input.write("p\r");
    expect(await second).toBe("p");
    const third = terminal.choose("Box\n", "Run it? Type yes: ", ["yes"]);
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
    const approval = terminal.choose("Box\n", "Run it? Type yes: ", ["yes"]).then((answer) => { settled = answer; return answer; });
    await tick();
    // The ask tool gets nothing while the approval is open, and its answer never reaches the approval.
    expect(await terminal.ask("Enable writes?", [{ label: "yes" }], false)).toBeUndefined();
    await tick();
    expect(settled).toBe("open");
    input.write("yes\r");
    expect(await approval).toBe("yes");
  } finally {
    terminal.close(); input.destroy();
    if (previousTerm === undefined) delete process.env.TERM; else process.env.TERM = previousTerm;
  }
});
