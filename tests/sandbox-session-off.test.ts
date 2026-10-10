import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ShellSandbox } from "../src/sandbox/manager";
import { fakeEngine } from "./support/sandbox-fakes";
import { removeTempDir } from "./support/temp-dir";

/** /sandbox off and /sandbox on: the session's sandbox, until Casper exits; never one your config or --no-sandbox turned off. */

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => removeTempDir(root))); });

async function sandbox(options: { off?: boolean; noSandboxFlag?: boolean; offByDefault?: boolean; on?: boolean } = {}): Promise<ShellSandbox> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-session-off-")));
  roots.push(root);
  return new ShellSandbox({ root: () => root, home: path.join(root, "home"), engine: fakeEngine(), problem: () => undefined, platform: "linux",
    settings: { user: options.off ? { off: true } : options.on ? { off: false } : {} }, ...(options.noSandboxFlag ? { noSandboxFlag: true } : {}),
    ...(options.offByDefault ? { offByDefault: true } : {}) });
}

test("/sandbox off runs commands unheld and says so; /sandbox on holds them again", async () => {
  const box = await sandbox();
  expect(box.on).toBe(true);
  expect(box.setSessionOff(true)).toContain("Sandbox off for this session");
  expect(box.on).toBe(false);
  expect(box.state).toEqual({ kind: "off", reason: "/sandbox off for this session; /sandbox on puts it back" });
  expect(box.asksFirst).toBe(false);
  expect(box.asksOutsideWrites).toBe(false);
  expect((await box.wrap("echo hi", { cwd: box.root } as never)).held).toBe(false);
  expect(box.setSessionOff(true)).toContain("already off");
  expect(box.setSessionOff(false)).toContain("Sandbox on for this session");
  expect(box.on).toBe(true);
  expect(box.state.kind).toBe("on");
});

test("a crew copy follows its session's /sandbox off", async () => {
  const box = await sandbox();
  const copy = box.forCopy(box.root);
  box.setSessionOff(true);
  expect(copy.on).toBe(false);
  box.setSessionOff(false);
  expect(copy.on).toBe(true);
});

test("/sandbox on can't undo sandbox: off or --no-sandbox", async () => {
  for (const box of [await sandbox({ off: true }), await sandbox({ noSandboxFlag: true })]) {
    expect(box.setSessionOff(false)).toContain("can't be turned on here");
    expect(box.setSessionOff(true)).toContain("already off");
    expect(box.on).toBe(false);
  }
});

test("at Casper's own start the sandbox is off unless the config turns it on: the AI's shell asks, the network server stays held", async () => {
  const box = await sandbox({ offByDefault: true });
  expect(box.on).toBe(false);
  expect(box.state.kind).toBe("default");
  expect(box.asksFirst).toBe(true);
  expect(box.asksOutsideWrites).toBe(true);
  expect(box.serverState.kind).toBe("on");
  expect((await box.wrap("echo hi", { cwd: box.root } as never)).held).toBe(false);
  expect(box.setSessionOff(true)).toContain("already off");
  expect(box.setSessionOff(false)).toContain("Sandbox on for this session");
  expect(box.on).toBe(true);
  expect(box.setSessionOff(true)).toContain("Sandbox off for this session");
  expect(box.state.kind).toBe("off");
  expect(box.asksFirst).toBe(false);
});

test("sandbox: on in the config holds commands from the start; sandbox: off and --no-sandbox turn the network server's off too", async () => {
  expect((await sandbox({ offByDefault: true, on: true })).on).toBe(true);
  for (const box of [await sandbox({ offByDefault: true, off: true }), await sandbox({ offByDefault: true, noSandboxFlag: true })]) {
    expect(box.state.kind).toBe("off");
    expect(box.serverState.kind).toBe("off");
    expect(box.asksFirst).toBe(false);
  }
});
