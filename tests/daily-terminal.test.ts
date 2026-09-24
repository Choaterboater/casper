import { afterAll, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RuntimeEventView } from "../src/app/events";
import { InteractiveTerminal } from "../src/tui/terminal";
import { withLoginDisplay } from "../src/tui/login";
import { posixOnly } from "./support/platform";

// The rich-surface path is gated on `TERM !== "dumb"`; a harness or CI shell that
// exports TERM=dumb must not silently downgrade these fixtures to readline input.
const ambientTerm = process.env.TERM;
process.env.TERM = "xterm-256color";
afterAll(() => { if (ambientTerm === undefined) delete process.env.TERM; else process.env.TERM = ambientTerm; });

const tick = () => new Promise(resolve => setTimeout(resolve, 90));

/** Fake TTY writer whose `until` resolves on the first write that satisfies the predicate, no timers. */
function fakeWriter(columns: number, rows: number) {
  let output = "";
  let pending: { test: (output: string) => boolean; resolve: () => void } | undefined;
  const writer = Object.assign(new EventEmitter(), { isTTY: true, columns, rows, write(text: string) {
    output += text;
    if (pending?.test(output)) { pending.resolve(); pending = undefined; }
  } });
  return {
    writer,
    get output() { return output; },
    until(test: (output: string) => boolean): Promise<void> {
      if (test(output)) return Promise.resolve();
      const { promise, resolve } = Promise.withResolvers<void>();
      pending = { test, resolve };
      return promise;
    },
  };
}

const REPAINT = "\x1b[2J\x1b[H\x1b[3J";
const plainLines = (frame: string) => frame.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g, "").split("\r\n");

test("live work status appears in a box before response text and clears when it streams", async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const screen = fakeWriter(80, 24);
  const terminal = new InteractiveTerminal(input, screen.writer, () => {}, () => {});
  let events!: RuntimeEventView;
  const output = { write: (text: string) => { events.beforeWrite(text); terminal.write(text); } };
  events = new RuntimeEventView(terminal, output, {
    updateFooter() {}, onToolEnd() {}, setTaskStop() {}, markRuntimeFailed() {},
  });
  try {
    terminal.setStatus("fixture"); terminal.start();
    events.handle({ type: "assistant_response_start", provider: "openai-codex", model: "gpt-6-luna" });
    await screen.until(output => Bun.stripANSI(output).includes(" Working "));
    expect(Bun.stripANSI(screen.output)).toContain("Waiting for openai-codex/gpt-6-luna · 0s");
    await screen.until(output => Bun.stripANSI(output).includes("Waiting for openai-codex/gpt-6-luna · 1s"));
    events.handle({ type: "tool_start", toolName: "write", toolCallId: "write-1", input: { path: "src/app.ts" } });
    await screen.until(output => Bun.stripANSI(output).includes("src/app.ts — running"));
    expect(Bun.stripANSI(screen.output)).toContain("Working");
    events.handle({ type: "tool_end", toolName: "write", toolCallId: "write-1", input: { path: "src/app.ts" }, isError: false });
    events.handle({ type: "assistant_text_delta", delta: "Working on it.\n" });
    screen.writer.columns = 79; screen.writer.emit("resize");
    await screen.until(output => output.split(REPAINT).length > 1 && output.split(REPAINT).at(-1)!.includes("Working on it."));
    const frame = plainLines(screen.output.split(REPAINT).at(-1)!).join("\n");
    expect(frame).toContain("Working on it.");
    expect(frame).not.toContain("Waiting for openai-codex/gpt-6-luna");
  } finally { terminal.close(); input.destroy(); }
});

test("streamed assistant Markdown renders lists and fences once, whole, and re-renders on width change", async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const screen = fakeWriter(60, 12);
  const terminal = new InteractiveTerminal(input, screen.writer, () => {}, () => {});
  try {
    terminal.setStatus("fixture"); terminal.start();
    void terminal.readCommand();
    const message = "Here is a plan:\n\n* first *item*\n* second **item** with `code`\n\n```ts\nconst x = 1;\n```\n\nDone.";
    for (let index = 0; index < message.length; index += 5) terminal.assistant(message.slice(index, index + 5));
    await screen.until(output => output.includes("Done."));
    terminal.endAssistant();
    terminal.write("after\n");
    await screen.until(output => output.includes("after"));
    // A width change forces a full repaint of the committed transcript from the Markdown source.
    screen.writer.columns = 40; screen.writer.emit("resize");
    await screen.until(output => output.split(REPAINT).length > 1 && output.split(REPAINT).at(-1)!.includes("after"));
    const frame = plainLines(screen.output.split(REPAINT).at(-1)!);
    const body = frame.slice(0, frame.indexOf("after")).filter(line => line.trim());
    // The fenced block is boxed with its language at the new width; no fence markers remain.
    expect(body.slice(0, 3)).toEqual(["Here is a plan:", "- first item", "- second item with code"]);
    expect(body[3]).toMatch(/^╭─ ts ─+╮$/);
    expect(body[4]).toMatch(/^│ const x = 1; +│$/);
    expect(body[5]).toMatch(/^╰─+╯$/);
    expect(body[6]).toBe("Done.");
    expect(body[3]!.length).toBe(40);
    expect(screen.output).not.toContain("\x1b[?1049h");
  } finally { terminal.close(); input.destroy(); }
});

test("a rows-only resize repositions without clearing scrollback; a columns change still repaints", async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const screen = fakeWriter(60, 12);
  const terminal = new InteractiveTerminal(input, screen.writer, () => {}, () => {});
  try {
    terminal.setStatus("fixture"); terminal.start();
    void terminal.readCommand();
    for (let line = 0; line < 20; line++) terminal.write(`line ${line}\n`);
    await screen.until(output => output.includes("line 19"));
    const painted = screen.output.length;
    screen.writer.rows = 8; screen.writer.emit("resize");
    terminal.write("shorter\n");
    await screen.until(output => output.includes("shorter"));
    expect(screen.output.slice(painted)).not.toContain("\x1b[3J");
    screen.writer.columns = 30; screen.writer.emit("resize");
    terminal.write("narrower\n");
    await screen.until(output => output.includes("narrower"));
    expect(screen.output.slice(painted)).toContain(REPAINT);
  } finally { terminal.close(); input.destroy(); }
});

test("login navigation on the live surface replaces rows without escaped controls or retained panels", async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const screen = fakeWriter(60, 30);
  const terminal = new InteractiveTerminal(input, screen.writer, () => {}, () => {});
  const controller = new AbortController();
  let pending: Promise<string | undefined> | undefined;
  try {
    terminal.start();
    const command = terminal.readCommand();
    input.write("retained draft"); await tick();
    pending = terminal.exclusiveHost()!.run(io => withLoginDisplay(io, controller.signal,
      display => display.choose("Choose provider", [
        { id: "first", label: "First provider" }, { id: "second", label: "Second provider" },
      ])));
    await screen.until(output => output.includes("Choose provider"));
    input.write("\x1b[B"); await tick();
    expect(screen.output).not.toContain("\\u{d}");
    input.write("\r");
    expect(await pending).toBe("second");
    // Force a repaint to observe the current surface, not historical terminal bytes.
    screen.writer.columns = 50; screen.writer.emit("resize"); await tick();
    const frame = plainLines(screen.output.split(REPAINT).at(-1)!).join("\n");
    expect(frame).toContain("retained draft");
    expect(frame).not.toContain("Choose provider");
    expect(frame).not.toContain("First provider");
    expect(frame).not.toContain("Second provider");
    input.write("\r");
    expect(await command).toBe("retained draft");
  } finally {
    controller.abort(); await pending;
    terminal.close(); input.destroy();
  }
});

// python3 runs the standard-library PTY fixture; Windows has no equivalent here.
posixOnly("offline interactive demo supports model/effort popovers and a real terminal resize", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-daily-pty-"));
  const child = Bun.spawn(["python3", path.join(import.meta.dir, "fixtures/daily-pty.py"), process.execPath, root], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 40_000);
  try {
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    expect(stdout).toContain("DAILY PTY PASS");
  } finally { clearTimeout(timer); child.kill(); await rm(root, { recursive: true, force: true }); }
}, 50_000);

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

test("Ctrl-C on an idle, empty editor arms exit; a second Ctrl-C exits and other keys disarm it", async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  let output = ""; let eofs = 0;
  const terminal = new InteractiveTerminal(input, { isTTY: true, columns: 100, rows: 30, write: text => { output += text; } }, () => {}, () => { eofs++; });
  try {
    terminal.setStatus("fixture"); terminal.start();
    const command = terminal.readCommand();
    await tick();
    input.write("\x03"); await tick();
    expect(output).toContain("Ctrl-C again to exit");
    expect(eofs).toBe(0);
    input.write("x"); await tick(); // Any other key disarms; the draft is now "x".
    input.write("\x03"); await tick(); // Clears the draft, does not exit.
    expect(eofs).toBe(0);
    input.write("\x03"); await tick(); // Arms again.
    input.write("\x03"); await tick(); // Exits.
    expect(eofs).toBe(1);
    expect(await command).toBeUndefined();
  } finally { terminal.close(); input.destroy(); }
});
