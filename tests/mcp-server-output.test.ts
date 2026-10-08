import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import path from "node:path";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { CallClock, CallClockTimeout } from "../src/mcp/clock";
import {
  classifyCallError, describeFailure, failureLines, HIDDEN, hideSecrets, MissingEnvironmentError,
  ServerOutput, stoppedMessage,
} from "../src/mcp/server-output";

const fixture = path.join(import.meta.dir, "fixtures/mcp-stderr-server.ts");
const SECRET = "hunter2-very-secret";

test("keeps only the last 40 lines and 8 KiB", () => {
  const output = new ServerOutput();
  for (let i = 0; i < 100; i++) output.push(`line ${i}\n`);
  expect(output.raw()).toHaveLength(40);
  expect(output.raw()[0]).toBe("line 60");
  expect(output.tail()).toEqual(Array.from({ length: 8 }, (_, i) => `line ${92 + i}`));

  const wide = new ServerOutput();
  for (let i = 0; i < 30; i++) wide.push(`${i} ${"y".repeat(1000)}\n`);
  const kept = wide.raw();
  expect(kept.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0)).toBeLessThanOrEqual(8 * 1024);
  expect(kept.at(-1)!.startsWith("29 ")).toBe(true);
});

test("joins lines split across chunks, including split UTF-8 characters", () => {
  const output = new ServerOutput();
  const bytes = Buffer.from("héllo wörld\nsecond");
  output.push(bytes.subarray(0, 2));
  output.push(bytes.subarray(2, 9));
  output.push(bytes.subarray(9));
  expect(output.raw()).toEqual(["héllo wörld", "second"]);
  output.push(" part\r\nthird\n");
  expect(output.tail(2)).toEqual(["second part", "third"]);
});

test("an endless line without a newline stays bounded", () => {
  const output = new ServerOutput();
  for (let i = 0; i < 100; i++) output.push("z".repeat(10_000));
  expect(Buffer.byteLength(output.raw().join("\n"))).toBeLessThanOrEqual(8 * 1024);
  expect(output.tail(1)[0]!.length).toBeLessThanOrEqual(200);
});

test("tail hides known secrets, token shapes and terminal controls, and cuts long lines", () => {
  const output = new ServerOutput();
  output.push(`connecting with ${SECRET} ok\n`);
  output.push("auth: Bearer abcdefghijk\n");
  output.push("config token=abc123 more\n");
  output.push("\x1b[31mred\x1b[0m text\x07\n");
  output.push(`${"w".repeat(300)}\n`);
  output.push("short\n"); // Values under 4 chars are not treated as secrets.
  const lines = output.tail(8, [SECRET, "abc"]);
  const joined = lines.join("\n");
  expect(joined).not.toContain(SECRET);
  expect(joined).not.toContain("abc123");
  expect(joined).not.toContain("abcdefghijk");
  expect(joined).not.toContain("\x1b");
  expect(joined).not.toContain("\x07");
  expect(lines[0]).toBe(`connecting with ${HIDDEN} ok`);
  expect(lines[3]).toBe("red text\\u{7}"); // Controls become visible escapes, never raw bytes.
  expect(lines[4]!.length).toBe(200);
  expect(lines[5]).toBe("short");
  expect(hideSecrets("a abcd-efgh b", ["abcd", "abcd-efgh"])).toBe(`a ${HIDDEN} b`);
});

test("attach drains a chatty server so it never blocks on a full pipe", async () => {
  const child = spawn(process.execPath, [fixture], { env: { ...process.env, FIXTURE_MODE: "chatty" }, stdio: ["ignore", "pipe", "pipe"] });
  const output = new ServerOutput().attach(child.stderr);
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  expect(code).toBe(3);
  expect(stdout).toBe("done\n");
  expect(output.tail(1)).toEqual(["last chatty line"]);
  expect(output.raw().length).toBeLessThanOrEqual(40);
}, 20_000);

test("detach keeps the stream draining", async () => {
  const stream = new PassThrough({ highWaterMark: 16 });
  const output = new ServerOutput().attach(stream);
  stream.write("kept\n");
  await Bun.sleep(5);
  output.detach();
  for (let i = 0; i < 200; i++) stream.write(`dropped ${i}\n`);
  await Bun.sleep(5);
  expect(stream.readableLength).toBe(0);
  expect(stream.writableLength).toBe(0);
  expect(output.raw()).toEqual(["kept"]);
});

test("a stdio server that fails to start: its own words, redacted, and the exit code", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [fixture], stderr: "pipe",
    env: { PATH: process.env.PATH ?? "", FIXTURE_MODE: "fail-start", FIXTURE_SECRET: SECRET },
  });
  // The stderr stream exists before start, so nothing is missed.
  const output = new ServerOutput().attach(transport.stderr as PassThrough);
  const client = new Client({ name: "test", version: "1" });
  const connecting = client.connect(transport);
  const child = (transport as unknown as { _process?: { once(e: "exit", f: (code: number | null) => void): void } })._process;
  const exited = new Promise<number | null>((resolve) => child?.once("exit", resolve));
  const failure = await connecting.then(() => undefined, (error: unknown) => error);
  const exitCode = await exited;
  await transport.close().catch(() => {});
  expect(failure).toBeDefined();

  const message = describeFailure(failure, { phase: "start", exited: true, exitCode, secrets: [SECRET], connectMs: 20_000 });
  expect(message).toBe("The server stopped while starting (exit code 1).");
  const tail = output.tail(8, [SECRET]);
  const shown = failureLines(message, tail).join("\n");
  expect(shown).toContain("Last lines from the server:");
  expect(shown).toContain("    | KeyError: 'CENTRAL_BASE_URL'");
  expect(shown).toContain(HIDDEN);
  expect(shown).not.toContain(SECRET);
  expect(shown).not.toContain("abc123");
}, 20_000);

test("start failures read plainly", () => {
  expect(describeFailure(new MissingEnvironmentError("CENTRAL_CLIENT_SECRET"), { phase: "start" }))
    .toBe("Missing environment variable CENTRAL_CLIENT_SECRET");
  const enoent = Object.assign(new Error("spawn uvx ENOENT"), { code: "ENOENT", path: "uvx", syscall: "spawn uvx" });
  // A launcher that comes with a tool says which tool and where to get it.
  expect(describeFailure(enoent, { phase: "start" })).toBe("Command not found: uvx. It comes with uv: https://docs.astral.sh/uv/getting-started/installation/");
  expect(describeFailure(enoent, { phase: "start", command: "npx" })).toBe("Command not found: npx. It comes with Node.js: https://nodejs.org/");
  expect(describeFailure(enoent, { phase: "start", command: "/usr/local/bin/docker" })).toBe("Command not found: /usr/local/bin/docker. Install Docker: https://docs.docker.com/get-docker/");
  expect(describeFailure(enoent, { phase: "start", command: "casper-no-such-cmd" })).toBe("Command not found: casper-no-such-cmd");
  expect(describeFailure(new Error("aborted"), { phase: "start", timedOut: true, connectMs: 20_000 })).toBe("No answer in 20s while starting.");
  expect(describeFailure(new McpError(ErrorCode.RequestTimeout, "Request timed out"), { phase: "start", connectMs: 20_000 }))
    .toBe("No answer in 20s while starting.");
  expect(describeFailure(new McpError(ErrorCode.ConnectionClosed, "Connection closed"), { phase: "start", exited: true, exitCode: null }))
    .toBe("The server stopped while starting.");
  expect(describeFailure(new McpError(ErrorCode.InvalidRequest, `bad key ${SECRET}`), { phase: "start", secrets: [SECRET] }))
    .toBe(`The server returned an error while starting: bad key ${HIDDEN}`);
  expect(describeFailure(new Error(`boom https://user:${SECRET}@host/x`), { phase: "start" })).not.toContain(SECRET);
  expect(stoppedMessage(2)).toBe("The server stopped (exit code 2). Next task may restart it.");
  expect(stoppedMessage(null)).toBe("The server stopped. Next task may restart it.");
  expect(failureLines("x", [])).toEqual(["x"]);
});

test("HTTP failures show the status and the redacted body, never header values", () => {
  const body = `{"error":"sensitive-server-body","echo":"${SECRET}","token":"abc123"}`;
  const error = new StreamableHTTPError(401, `Error POSTing to endpoint: ${body}`);
  const message = describeFailure(error, { phase: "start", secrets: [SECRET] });
  expect(message.startsWith("The server said HTTP 401: ")).toBe(true);
  expect(message).toContain("sensitive-server-body");
  expect(message).not.toContain(SECRET);
  expect(message).not.toContain("abc123");
  const long = describeFailure(new StreamableHTTPError(500, `Error POSTing to endpoint: ${"b".repeat(1000)}`), { phase: "start" });
  expect(long.length).toBeLessThanOrEqual("The server said HTTP 500: ".length + 300);
  expect(describeFailure(new StreamableHTTPError(404, "Error POSTing to endpoint: "), { phase: "start" })).toBe("The server said HTTP 404.");
});

test("call failures tell the model what happened and not to retry", () => {
  const idle = new CallClockTimeout("idle", 500);
  expect(describeFailure(new McpError(ErrorCode.RequestTimeout, String(idle)), { phase: "call", server: "generic", clockReason: "idle", idleMs: 500 }))
    .toBe("No answer from generic in 0.5s. It may have run. Do not retry on your own; tell the user.");
  expect(describeFailure(idle, { phase: "call", server: "central", lastProgress: `polling job 3/12 ${SECRET} ${"p".repeat(300)}`, secrets: [SECRET] }))
    .toMatch(/^No answer from central in 0\.5s\. It may have run\. Do not retry on your own; tell the user\. Last progress: polling job 3\/12 ••• p+…\.$/);
  const withProgress = describeFailure(idle, { phase: "call", server: "central", lastProgress: "x".repeat(500) });
  expect(withProgress.slice(withProgress.indexOf("Last progress: ") + 15).length).toBeLessThanOrEqual(121);
  expect(describeFailure(new McpError(ErrorCode.RequestTimeout, "x"), { phase: "call", server: "junos", clockReason: "hard", hardMs: 600_000 }))
    .toBe("junos was still working after 10m and was stopped. It may have run. Do not retry on your own; tell the user.");
  expect(describeFailure(new McpError(-32602, "site 'lab' not found"), { phase: "call", server: "central" }))
    .toBe("central returned an error: site 'lab' not found. It may or may not have run.");
  const long = describeFailure(new McpError(-32603, "e".repeat(2000)), { phase: "call", server: "s" });
  expect(long.length).toBeLessThan(600);
  expect(describeFailure(new McpError(ErrorCode.ConnectionClosed, "Connection closed"), { phase: "call", server: "s", exited: true, exitCode: 1 }))
    .toBe("s stopped during the call (exit code 1). It may have run. Do not retry on your own; tell the user.");
});

test("a real clock abort maps to the idle message", async () => {
  const clock = new CallClock(20, 5_000);
  await new Promise((resolve) => clock.signal.addEventListener("abort", resolve));
  const text = describeFailure(clock.signal.reason, { phase: "call", server: "generic" });
  expect(text).toBe("No answer from generic in 0s. It may have run. Do not retry on your own; tell the user.");
  clock.dispose();
});

test("server errors keep the connection; timeouts and closed connections do not", () => {
  expect(classifyCallError(new McpError(-32602, "site 'lab' not found"))).toBe("server-answered");
  // A server may send -32000 itself; only the SDK's own "Connection closed" is a transport failure.
  expect(classifyCallError(new McpError(ErrorCode.ConnectionClosed, "backend unavailable"))).toBe("server-answered");
  expect(classifyCallError(new McpError(ErrorCode.ConnectionClosed, "Connection closed"))).toBe("transport");
  expect(classifyCallError(new McpError(ErrorCode.RequestTimeout, "Request timed out"))).toBe("transport");
  expect(classifyCallError(new McpError(ErrorCode.InvalidRequest, 'Tool "x" requires task-based execution. Use client.experimental.tasks.callToolStream() instead.')))
    .toBe("not-sent");
  expect(classifyCallError(new Error("socket hang up"))).toBe("transport");
  expect(classifyCallError(new DOMException("aborted", "AbortError"))).toBe("transport");
});
