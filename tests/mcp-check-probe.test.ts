import { expect, test } from "bun:test";
import path from "node:path";
import { probeServer } from "../src/mcp/check/probe";
import type { StartDefinition } from "../src/mcp/check/examples";
import { cleanEnv } from "./support/env";
import { CHILD_KILL_MS, childTestLimit } from "./support/limits";
import { processGone } from "./support/wait";

const fixture = path.resolve(import.meta.dir, "fixtures/mcp-check-server.ts");
const definition = (mode: string, env: Record<string, string> = {}): Extract<StartDefinition, { type: "stdio" }> =>
  ({ name: "fixture", source: "--", cwd: import.meta.dir, type: "stdio", command: process.execPath, args: [fixture], env: { FIXTURE_MODE: mode, ...env } });

test("a server that starts lists every tool and is stopped afterwards", async () => {
  const result = await probeServer(definition("good"), { connectMs: CHILD_KILL_MS, env: cleanEnv(), live: false });
  expect(result.started).toBe(true);
  expect(result.tools.map((tool) => tool.name)).toContain("glp_write_status");
  expect(result.serverInfo?.name).toBe("casper-check-fixture");
  expect(result.stdoutNoise).toEqual([]);
  expect(result.pid).toBeGreaterThan(0);
  expect(await processGone(result.pid!)).toBe(true);
}, childTestLimit());

test("plain text on stdout is recorded, not fatal", async () => {
  const result = await probeServer(definition("stdout-noise"), { connectMs: CHILD_KILL_MS, env: cleanEnv(), live: false });
  expect(result.started).toBe(true);
  expect(result.stdoutNoise).toEqual(["File devices.json not found."]);
}, childTestLimit());

test("a slow start fails after the limit, shows stderr with secrets hidden, and leaves no process", async () => {
  // The limit leaves room for the fixture to start and print its first line: a busy machine took over 0.5 s for that.
  const result = await probeServer(definition("slow-start", { FIXTURE_START_DELAY_MS: "30000" }), { connectMs: 2_500, env: cleanEnv(), live: false });
  expect(result.started).toBe(false);
  expect(result.error).toBe("Did not start in 2.5 s.");
  expect(result.stderrTail.join("\n")).toContain("loading devices with token=<redacted>");
  expect(result.stderrTail.join("\n")).not.toContain("abc123");
  expect(result.pid).toBeGreaterThan(0);
  expect(await processGone(result.pid!)).toBe(true);
});

test("a server that exits early says so, with its last lines and secrets hidden", async () => {
  const result = await probeServer(definition("secret-stderr"), { connectMs: 10_000, env: cleanEnv(), live: false });
  expect(result.error).toBe("Stopped before it was ready (exit code 1).");
  const tail = result.stderrTail.join("\n");
  expect(tail).toContain("Starting with token=<redacted>");
  expect(tail).not.toContain("abc123");
  expect(tail).not.toContain("sk-fixturesecret12345");
});

test("a command that does not exist is a plain start failure", async () => {
  const result = await probeServer({ ...definition("good"), command: "casper-no-such-server" }, { connectMs: 5000, env: cleanEnv(), live: false });
  expect(result.started).toBe(false);
  expect(result.error).toBe("Did not start: casper-no-such-server not found.");
});

test("stderr hides values given under credential names, but not plain paths", async () => {
  const script = "console.error('path ' + process.env.PYTHONPATH + ' key ' + process.env.MY_TOKEN); process.exit(1)";
  const result = await probeServer({ ...definition("good"), args: ["-e", script], env: { PYTHONPATH: "/repo/src", MY_TOKEN: "tok-12345" } },
    { connectMs: 5000, env: cleanEnv(), live: true });
  expect(result.stderrTail.join("\n")).toContain("path /repo/src key •••");
  expect(result.stderrTail.join("\n")).not.toContain("tok-12345");
});
