import { expect, test } from "bun:test";
import { RpcConnection } from "../src/acp/rpc";
import { closeSessionProcess } from "../src/acp/server";
import { cleanEnv } from "./support/env";

/** A session process that never exits on its own: it ignores its input ending and the cancel. */
function stuckChild() {
  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000); console.log('up');"],
    { env: cleanEnv(), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const connection = new RpcConnection(child.stdout, (line) => { try { child.stdin.write(line); child.stdin.flush(); } catch { /* gone */ } });
  return { child, connection };
}

test("session/close stops a session process that does not exit when its input ends, and still answers", async () => {
  const { child, connection } = stuckChild();
  try {
    // A prompt whose reply never comes: the close waits for it only as long as it may.
    const prompts = new Set([new Promise<void>(() => {})]);
    const started = performance.now();
    await closeSessionProcess({ child, connection, prompts }, "stuck-session", 200);
    expect(performance.now() - started).toBeLessThan(8_000);
    await child.exited;
    expect(child.exitCode === 0).toBe(false);
    expect(child.killed).toBe(true);
    if (process.platform !== "win32") expect(child.signalCode).toBe("SIGKILL");
  } finally { child.kill("SIGKILL"); }
}, 20_000);

test("session/close does not kill a session process that exits by itself", async () => {
  const child = Bun.spawn([process.execPath, "-e", "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));"],
    { env: cleanEnv(), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const connection = new RpcConnection(child.stdout, (line) => { try { child.stdin.write(line); child.stdin.flush(); } catch { /* gone */ } });
  try {
    await closeSessionProcess({ child, connection, prompts: new Set() }, "tidy-session", 10_000);
    expect(await child.exited).toBe(0);
    expect(child.signalCode).toBeNull();
  } finally { child.kill("SIGKILL"); }
}, 20_000);
