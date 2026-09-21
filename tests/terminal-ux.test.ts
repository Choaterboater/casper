import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { formatRuntimeStatus, formatToolActivity, MarkdownFormatter, redactPreview, terminalText } from "../src/tui/format";
import { posixOnly } from "./support/platform";

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

test("formatting is bounded to Markdown presentation and neutralizes terminal controls", () => {
  const source = "# Heading\n**bold** `code`";
  const plain = new MarkdownFormatter(false);
  expect(source.split("\n").map((line) => plain.line(line)).join("\n")).toBe(source);
  const color = new MarkdownFormatter(true);
  expect(color.line("# Heading")).toContain("\x1b[1;36m");
  expect(color.line("**bold** `code`")).toContain("\x1b[36m");
  color.line("```", false); color.line("```ts", false);
  color.line("```ts"); expect(color.line("**literal**")).toBe("\x1b[36m**literal**\x1b[0m");
  expect(terminalText("hi\x1b[2J\x1b]0;title\x07\u202efake")).toBe("hi\\u{202e}fake");
});

test("model and auth display distinguishes uninitialized, missing, configured and unknown", () => {
  expect(formatRuntimeStatus()).toContain("not initialized");
  expect(formatRuntimeStatus({ provider: "fixture", model: "test", auth: "configured" })).toContain("not a connection test");
  expect(formatRuntimeStatus({ provider: "fixture", model: "test", auth: "missing" })).toContain("credentials missing");
  expect(formatRuntimeStatus({ auth: "unknown" })).toContain("none selected");
});

// python3 runs the standard-library PTY fixture; Windows has no equivalent here.
posixOnly("real PTY: input survives streamed output, cancellation and exact confirmations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-terminal-pty-")); roots.push(root);
  const child = Bun.spawn(["python3", path.join(import.meta.dir, "fixtures/terminal-pty.py"), process.execPath, root], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 25_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(stdout).toContain("PTY PASS");
  } finally { clearTimeout(timer); child.kill(); }
}, 30_000);
