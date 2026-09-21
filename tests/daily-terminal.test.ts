import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InteractiveTerminal } from "../src/tui/terminal";
import { posixOnly } from "./support/platform";

const tick = () => new Promise(resolve => setTimeout(resolve, 90));

// python3 runs the standard-library PTY fixture; Windows has no equivalent here.
posixOnly("offline interactive demo supports model/effort popovers and a real terminal resize", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-daily-pty-"));
  const child = Bun.spawn(["python3", path.join(import.meta.dir, "fixtures/daily-pty.py"), process.execPath, root], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 20_000);
  try {
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    expect(stdout).toContain("DAILY PTY PASS");
  } finally { clearTimeout(timer); child.kill(); await rm(root, { recursive: true, force: true }); }
}, 25_000);

test("one-shot TTY output stays immediate and separates the final assistant line", () => {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  let output = "";
  const terminal = new InteractiveTerminal(input, { isTTY: true, write: text => { output += text; } }, () => {}, () => {});
  terminal.assistant("partial");
  expect(output).toBe("partial");
  terminal.endAssistant();
  expect(output).toBe("partial\n");
  terminal.close(); input.destroy();
});

test("multiline drafts and history survive narrow terminal resizing", async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  let output = "";
  const writer = Object.assign(new EventEmitter(), { isTTY: true, columns: 80, rows: 24, write(text: string) { output += text; } });
  const terminal = new InteractiveTerminal(input, writer, () => {}, () => {});
  try {
    terminal.setStatus("fixture/main │ local/model · high │ ctx — │ idle");
    terminal.start();
    const command = terminal.readCommand();
    input.write("first line\nsecond line"); // Ctrl+J, not Enter, creates a newline.
    await tick();
    writer.columns = 32; writer.emit("resize"); await tick();
    terminal.write("Observation while resizing\n");
    input.write("\r");
    expect(await command).toBe("first line\nsecond line");
    const recalled = terminal.readCommand();
    input.write("\x1b[A"); await tick(); input.write("\r");
    expect(await recalled).toBe("first line\nsecond line");
    expect(output).not.toContain("\x1b[?1049h"); // No alternate screen takeover.
  } finally { terminal.close(); input.destroy(); }
});

test("partial slash selection inserts a command without executing it", async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const terminal = new InteractiveTerminal(input, { isTTY: true, columns: 100, rows: 24, write() {} }, () => {}, () => {});
  try {
    terminal.setStatus("fixture"); terminal.start();
    let submitted = false;
    const command = terminal.readCommand().then(value => { submitted = true; return value; });
    input.write("/eff"); await tick(); input.write("\r"); await tick();
    expect(submitted).toBe(false);
    input.write("\r"); expect((await command)?.trim()).toBe("/effort");
  } finally { terminal.close(); input.destroy(); }
});

test("interactive input shows persistent status and slash discovery without submitting or losing drafts", async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  let output = "";
  const terminal = new InteractiveTerminal(input, { isTTY: true, columns: 100, rows: 30, write: text => { output += text; } }, () => {}, () => {});
  try {
    terminal.setStatus("Casper/main │ fixture/test · high │ ctx unavailable │ idle", process.cwd());
    terminal.start();
    let submitted = false;
    const command = terminal.readCommand().then(value => { submitted = true; return value; });
    await tick();
    expect(output).toContain("fixture/test");
    input.write("/"); await tick();
    expect(output).toContain("Change model");
    expect(submitted).toBe(false);
    input.write("\x03"); await tick(); // clear draft, not exit
    input.write("hello"); await tick();
    terminal.write("Background observation\n"); await tick();
    input.write("\r");
    expect(await command).toBe("hello");
    expect(output).toContain("Background observation");
  } finally { terminal.close(); input.destroy(); }
});
