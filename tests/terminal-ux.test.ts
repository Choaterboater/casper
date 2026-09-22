import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { formatRuntimeStatus, formatToolActivity, markdownTheme, redactPreview, terminalText } from "../src/tui/format";
import { InteractiveTerminal } from "../src/tui/terminal";
import { posixOnly } from "./support/platform";

// readline delivers a written line on a later turn of the event loop; no wall-clock wait involved.
const delivered = () => new Promise(resolve => setImmediate(resolve));

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

test("tool display gives targets/status, redacts common credentials and never invents verifier evidence", () => {
  const input = { command: 'TOKEN=secret curl -H "Authorization: Bearer hidden" https://user:pass@host/path --password "private value"' };
  const start = formatToolActivity({ type: "tool_start", toolName: "bash", input });
  for (const secret of ["secret", "hidden", "user:pass", "private value"]) expect(start).not.toContain(secret);
  expect(start).toContain("curl"); expect(start).toContain("running");
  const end = formatToolActivity({ type: "tool_end", toolName: "bash", input, isError: false }, 1200);
  expect(end).toContain("completed · 1.2s"); expect(end).not.toMatch(/passed|exit 0/);
  const failure = formatToolActivity({ type: "tool_end", toolName: "read", input: { path: "src/missing.ts" },
    output: { text: "ENOENT\napi_key=secret", truncated: true }, isError: true });
  expect(failure).toContain("src/missing.ts — failed"); expect(failure).toContain("ENOENT");
  expect(failure).not.toContain("secret"); expect(failure).toContain("[truncated]");
  expect(redactPreview("sk-abcdefghijk ghp_abcdefghijk")).toBe("<redacted> <redacted>");
});

test("Markdown theme stays plain without color and terminal controls are neutralized", () => {
  const plain = markdownTheme(false);
  expect(plain.heading("# Heading") + plain.code("code") + plain.codeBlockBorder("```")).toBe("# Headingcode```");
  expect(markdownTheme(true).heading("# Heading")).toBe("\x1b[1;36m# Heading\x1b[0m");
  expect(terminalText("hi\x1b[2J\x1b]0;title\x07\u202efake")).toBe("hi\\u{202e}fake");
});

test("model and auth display distinguishes uninitialized, missing, configured and unknown", () => {
  expect(formatRuntimeStatus()).toContain("not initialized");
  expect(formatRuntimeStatus({ provider: "fixture", model: "test", auth: "configured" })).toContain("not a connection test");
  expect(formatRuntimeStatus({ provider: "fixture", model: "test", auth: "missing" })).toContain("credentials missing");
  expect(formatRuntimeStatus({ auth: "unknown" })).toContain("none selected");
});

test("plain line input typed before the first prompt is kept; lines typed during work are dropped", async () => {
  const input = new PassThrough();
  const terminal = new InteractiveTerminal(input, { write() {} }, () => {}, () => {});
  terminal.start();
  input.write("/status\n/help\n");
  await delivered();
  expect(await terminal.readCommand()).toBe("/status");
  input.write("typed during work\n"); // No readCommand pending: not queued.
  await delivered();
  expect(await terminal.readCommand()).toBe("/help");
  const next = terminal.readCommand();
  input.write("after\n");
  expect(await next).toBe("after");
  terminal.close();
});

// python3 runs the standard-library PTY fixture; Windows has no equivalent here.
posixOnly("real PTY: input survives streamed output, cancellation and exact confirmations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-terminal-pty-")); roots.push(root);
  const child = Bun.spawn(["python3", path.join(import.meta.dir, "fixtures/terminal-pty.py"), process.execPath, root], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 60_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(stdout).toContain("PTY PASS");
  } finally { clearTimeout(timer); child.kill(); }
}, 70_000);
