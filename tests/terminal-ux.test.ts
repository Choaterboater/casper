import { afterEach, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { WORDMARK_COLUMNS, wordmarkHeader } from "../src/tui/banner";
import { formatRuntimeStatus, noModelFooter, formatToolActivity, markdownTheme, redactPreview, terminalText } from "../src/tui/format";
import { InteractiveTerminal } from "../src/tui/terminal";
import { hasSignIn } from "../src/tui/model-preference";
import { posixOnly } from "./support/platform";
import { PTY_TEST_MS, runPtyFixture } from "./support/pty";
import { cleanEnv } from "./support/env";
import { removeTempDir } from "./support/temp-dir";

// readline delivers a written line on a later turn of the event loop; no wall-clock wait involved.
const delivered = () => new Promise(resolve => setImmediate(resolve));

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => removeTempDir(root))); });

test("tool display gives targets/status, redacts common credentials and never invents verifier evidence", () => {
  const input = { command: 'TOKEN=secret curl -H "Authorization: Bearer hidden" https://user:pass@host/path --password "private value"' };
  const start = formatToolActivity({ type: "tool_start", toolName: "bash", input });
  for (const secret of ["secret", "hidden", "user:pass", "private value"]) expect(start).not.toContain(secret);
  expect(start).toBe("• bash · curl https://<redacted>@host/path …");
  const end = formatToolActivity({ type: "tool_end", toolName: "bash", input, isError: false }, 1200);
  expect(end).toBe("✓ bash · curl https://<redacted>@host/path … · 1.2s"); expect(end).not.toMatch(/passed|exit 0|completed/);
  const failure = formatToolActivity({ type: "tool_end", toolName: "read", input: { path: "src/missing.ts" },
    output: { text: "ENOENT\napi_key=secret", truncated: true }, isError: true });
  expect(failure).toContain("✗ read · src/missing.ts — failed"); expect(failure).toContain("ENOENT");
  expect(failure).not.toContain("secret"); expect(failure).toContain("[truncated]");
  expect(redactPreview("sk-abcdefghijk ghp_abcdefghijk")).toBe("<redacted> <redacted>");
  expect(formatToolActivity({ type: "tool_start", toolName: "grep", input: { pattern: "TODO", path: "src" } })).toBe("• grep · TODO · src");
});

test("a casper_check skip shows neither ✓ nor ✗", () => {
  const skipped = formatToolActivity({ type: "tool_end", toolName: "casper_check", input: { check: "junos" },
    output: { text: JSON.stringify({ name: "junos", cwd: "/p", status: "skip", reason: "no device" }), truncated: false }, isError: false }, 300);
  expect(skipped).toBe("○ casper_check · junos — skipped");
  const passed = formatToolActivity({ type: "tool_end", toolName: "casper_check", input: { check: "test" },
    output: { text: JSON.stringify({ name: "test", cwd: "/p", status: "pass", stdout: '{"status":"skip"}' }), truncated: false }, isError: false });
  expect(passed).toBe("✓ casper_check · test");
});

test("Markdown theme stays plain without color and terminal controls are neutralized", () => {
  const plain = markdownTheme(false);
  expect(plain.heading("# Heading") + plain.code("code") + plain.codeBlockBorder("```")).toBe("# Headingcode```");
  expect(markdownTheme(true).heading("# Heading")).toBe("\x1b[1;36m# Heading\x1b[0m");
  expect(terminalText("hi\x1b[2J\x1b]0;title\x07\u202efake")).toBe("hi\\u{202e}fake");
  const clean = "hello\n\tworld";
  expect(terminalText(clean)).toBe(clean);
});

test("a carriage return in tool output is a line break, not the literal text \\u{d}", () => {
  // Windows and ssh output end lines with CRLF; a progress bar redraws its line with a lone CR.
  expect(terminalText("one\r\ntwo\r\n")).toBe("one\ntwo\n");
  expect(terminalText("10%\r20%\r100%")).toBe("10%\n20%\n100%");
  expect(terminalText("a\rb\x1b[2Jc")).toBe("a\nbc");
  expect(terminalText("ok\r\n‮fake")).toBe("ok\n\\u{202e}fake");
  expect(terminalText("one\r\ntwo\r\n")).not.toContain("\\u{d}");
});

test("a wide-character and emoji line measures the cells a terminal draws", () => {
  // A text-default symbol plus U+FE0F is one cell in iTerm2 and xterm.js but two in Pi's layout;
  // without the selector both say one. CJK and emoji-presentation symbols stay two cells.
  const line = terminalText("你好 🚀 ✅ ⚠️ ✔️ 1️⃣ done");
  expect(line).toBe("你好 🚀 ✅ ⚠ ✔ 1\u20e3 done");
  // 你好 4 · 🚀 2 · ✅ 2 · ⚠ 1 · ✔ 1 · 1⃣ 1 · done 4 · six spaces.
  expect(visibleWidth(line)).toBe(21);
  // In a joined sequence the selector belongs to one two-cell emoji and stays.
  expect(terminalText("❤️\u200d🔥")).toBe("❤️\u200d🔥");
});

test("the startup wordmark gives way to the one-line header when the window narrows, never wrapping the art", () => {
  const header = wordmarkHeader(false);
  const wide = header.render(WORDMARK_COLUMNS);
  expect(wide.some(line => line.includes("▄▄███▄▄"))).toBe(true);
  expect(wide.at(-1)).toMatch(/^ version {3}\S+ · your coding companion$/);
  for (const width of [WORDMARK_COLUMNS - 1, 30]) {
    const narrow = header.render(width);
    expect(narrow.join(" ")).toMatch(/^CASPER \S+ · your coding companion$/);
    for (const line of narrow) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  }
});

test("model and auth display distinguishes uninitialized, missing, configured and unknown", () => {
  expect(formatRuntimeStatus(undefined, undefined, false)).toBe(" model     not signed in · type a request to sign in");
  // Where sign-in can't open (plain terminal, script), the hint is the step that works.
  expect(formatRuntimeStatus(undefined, undefined, false, false)).toBe(" model     not signed in · run casper in a terminal and type /login");
  expect(formatRuntimeStatus(undefined, undefined, true)).toBe(" model     none yet · your first request picks one (/model to choose)");
  expect(formatRuntimeStatus({ provider: "fixture", model: "test", auth: "configured" })).toContain("not a connection test");
  expect(formatRuntimeStatus({ provider: "fixture", model: "test", auth: "missing" })).toContain("credentials missing");
  expect(formatRuntimeStatus({ auth: "unknown" })).toContain("none selected");
  expect(formatRuntimeStatus({ provider: "fixture", model: "test", auth: "configured", thinkingLevel: "high", configuredEffort: "auto", autoEffort: { state: "pending" }, modelRole: "fast" }))
    .toContain("effort auto → high for now; your next request picks the level · role fast");
  expect(formatRuntimeStatus({ provider: "fixture", model: "test", auth: "configured", thinkingLevel: "low", configuredEffort: "auto", autoEffort: { state: "classified" } })).toContain("effort auto → low\n");
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

test("plain line input that reaches EOF before or with the first prompt is still read in order", async () => {
  const ended = new PassThrough();
  let eof = 0;
  const early = new InteractiveTerminal(ended, { write() {} }, () => {}, () => { eof++; });
  early.start();
  ended.end("/status\n/help\n");
  await delivered();
  expect(await early.readCommand()).toBe("/status");
  expect(await early.readCommand()).toBe("/help");
  expect(await early.readCommand()).toBeUndefined();
  // EOF with lines still queued is not a hang-up of the running command; the loop drains them.
  expect(eof).toBe(0);
  early.close();

  const chunked = new PassThrough();
  const pending = new InteractiveTerminal(chunked, { write() {} }, () => {}, () => {});
  pending.start();
  const first = pending.readCommand();
  chunked.end("/status\n/foo\n"); // One chunk: /foo arrived with /status, not during its work.
  expect(await first).toBe("/status");
  await delivered();
  expect(await pending.readCommand()).toBe("/foo");
  expect(await pending.readCommand()).toBeUndefined();
  pending.close();
});

test("piped stdin runs every line through the real CLI", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-piped-")); roots.push(root);
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await Promise.all([mkdir(home), mkdir(project)]);
  const env = cleanEnv({ HOME: home, CASPER_PROFILE: "default", NO_COLOR: undefined });
  const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../src/cli.ts")], {
    cwd: project, env, stdin: new Blob(["/status\n/help\n/nope\n"]), stdout: "pipe", stderr: "pipe",
  });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  // Plain mode does not echo input; each command's own output marks that it ran.
  const status = stdout.indexOf(" policy "), help = stdout.indexOf("/help all"), unknown = stdout.indexOf('Unknown command "/nope"');
  expect({ code, status: status >= 0, help: help > status, unknown: unknown > help }).toEqual({ code: 0, status: true, help: true, unknown: true });
}, 30_000);

test("with no sign-in, the banner says so in one line and how to start; the footer says the same", async () => {
  expect(noModelFooter(false)).toBe("not signed in · type a request to sign in");
  expect(noModelFooter(true)).not.toContain("not initialized");
  expect(noModelFooter(false, false)).toBe("not signed in · run casper in a terminal and type /login");
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-banner-")); roots.push(root);
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await Promise.all([mkdir(home), mkdir(project)]);
  const env = cleanEnv({ HOME: home, USERPROFILE: home, CASPER_PROFILE: "default" });
  for (const name of Object.keys(env)) if (/_API_KEY$|_TOKEN$/.test(name)) delete env[name];
  const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../src/cli.ts")], {
    cwd: project, env, stdin: new Blob(["explain this project\n/exit\n"]), stdout: "pipe", stderr: "pipe",
  });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  expect(code).toBe(0);
  // Piped stdin can't open sign-in, so neither the banner nor a request says "type a request".
  expect(stdout).toContain(" model     not signed in · run casper in a terminal and type /login\n");
  expect(stdout).not.toContain("Type a request");
  expect(stdout).not.toContain("type a request");
  expect(stdout).toContain("[model] Not signed in yet. Run casper in a terminal and type /login.");
  expect(stdout).not.toContain(" auth      ");
}, 180_000);

test("the startup banner names a saved default model instead of saying no model is set up", async () => {
  expect(formatRuntimeStatus(undefined, "fixture/first · effort high")).toBe(
    " model     fixture/first · effort high (starts on your first request; /model to change)");
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-banner-")); roots.push(root);
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await Promise.all([mkdir(path.join(home, ".casper"), { recursive: true }), mkdir(project)]);
  await writeFile(path.join(home, ".casper", "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "first", defaultThinkingLevel: "high" }));
  // Windows resolves the home directory from USERPROFILE, not HOME.
  const env = cleanEnv({ HOME: home, USERPROFILE: home, CASPER_PROFILE: "default" });
  for (const args of [[], ["/exit"]]) {
    const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../src/cli.ts"), ...args], {
      cwd: project, env, stdin: new Blob(["/exit\n"]), stdout: "pipe", stderr: "pipe",
    });
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(code).toBe(0);
    expect(stdout).toContain(" model     fixture/first · effort high (starts on your first request; /model to change)");
    expect(stdout).not.toContain("none saved yet");
    expect(stdout).not.toContain("/login to set up a provider");
  }
}, 30_000);

// python3 runs the standard-library PTY fixture; Windows has no equivalent here.
posixOnly("real PTY: input survives streamed output, cancellation and exact confirmations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-terminal-pty-")); roots.push(root);
  const { exit: code, stdout, stderr } = await runPtyFixture("terminal-pty.py", [root]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(stdout).toContain("PTY PASS");
}, PTY_TEST_MS);

test("the screen keeps 'token add' readable and leaves Casper's own <secret hidden> as it is", () => {
  expect(redactPreview("ssh build-server 'pveum user token add root@pam sampleapp --privsep 0'")).toBe("ssh build-server 'pveum user token add root@pam sampleapp --privsep 0'");
  expect(redactPreview("sshpass -p '<secret hidden>' ssh root@10.0.0.5 id")).toBe("sshpass -p '<secret hidden>' ssh root@10.0.0.5 id");
  expect(redactPreview("--password '<secret hidden>' x; token: abc123")).toBe("--password '<secret hidden>' x; token: <redacted>");
});

test("only a known provider's key counts as signed in, not any *_API_KEY variable", async () => {
  const agent = await mkdtemp(path.join(os.tmpdir(), "casper-signin-")); roots.push(agent);
  expect(await hasSignIn(agent, {})).toBe(false);
  expect(await hasSignIn(agent, { STRIPE_API_KEY: "x", MIST_API_KEY: "y" })).toBe(false);
  expect(await hasSignIn(agent, { OPENROUTER_API_KEY: "" })).toBe(false);
  expect(await hasSignIn(agent, { OPENROUTER_API_KEY: "x" })).toBe(true);
  expect(await hasSignIn(agent, { GROQ_API_KEY: "x" })).toBe(true);
  expect(await hasSignIn(agent, { ANTHROPIC_OAUTH_TOKEN: "x" })).toBe(true);
  expect(await hasSignIn(agent, { AWS_BEARER_TOKEN_BEDROCK: "x" })).toBe(true);
  // Casper's own secrets are not a model sign-in.
  expect(await hasSignIn(agent, { CASPER_API_KEY: "x" })).toBe(false);
  await writeFile(path.join(agent, "auth.json"), JSON.stringify({ openrouter: { type: "api_key", key: "x" } }));
  expect(await hasSignIn(agent, {})).toBe(true);
});
