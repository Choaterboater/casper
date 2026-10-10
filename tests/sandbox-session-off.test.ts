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

async function sandbox(options: { off?: boolean; noSandboxFlag?: boolean } = {}): Promise<ShellSandbox> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-session-off-")));
  roots.push(root);
  return new ShellSandbox({ root: () => root, home: path.join(root, "home"), engine: fakeEngine(), problem: () => undefined, platform: "linux",
    settings: { user: options.off ? { off: true } : {} }, ...(options.noSandboxFlag ? { noSandboxFlag: true } : {}) });
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
  expect(box.setSessionOff(false)).toContain("Sandbox on again");
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
    expect(box.setSessionOff(true)).toContain("not running here already");
    expect(box.on).toBe(false);
  }
});
