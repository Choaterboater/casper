import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runtimeShell, SHELL_DECLINED } from "../src/app/sandbox";
import { NO } from "../src/app/safe-choices";
import { ShellSandbox } from "../src/sandbox/manager";
import { readOnlyCommand } from "../src/sandbox/read-only";
import { routineCommand } from "../src/sandbox/routine";
import { SandboxStore } from "../src/sandbox/store";
import { removeTempDir } from "./support/temp-dir";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-read-privacy-")));
  cleanup.push(() => removeTempDir(base));
  const root = path.join(base, "project"), home = path.join(base, "home");
  await mkdir(root); await mkdir(home);
  const where = { root, home };
  const store = new SandboxStore(path.join(base, "state"));
  const sandbox = new ShellSandbox({ root: () => root, home, store, offByDefault: true });
  cleanup.push(() => sandbox.close());
  const asked: string[] = [];
  const shell = runtimeShell({ canAsk: () => true, pick: async (question) => { asked.push(question); return NO; },
    write() {}, planning: () => false, routineCommands: () => true }, sandbox, store);
  cleanup.push(() => shell.close());
  return { where, shell, asked };
}

for (const command of ["ps -E", "ps -axE", "ps -wwEax", "ps e", "ps eww", "ps auxe", "ps E", "ps -o -E", "ps -o etime eww", "ps --format=comm=NAME eww", "ps -ocomm=NAME eww", "ps -Eo pid", "ps *"]) {
  test(`${command} asks instead of exposing process environments`, async () => {
    const { where, shell, asked } = await fixture();
    expect(readOnlyCommand(command, where)).toBe(false);
    expect(routineCommand(command, where)).toBe(false);
    expect(await shell.approve!(command)).toBe(SHELL_DECLINED);
    expect(asked).toHaveLength(1);
  });
}

test("ps -e keeps Linux all-process selection without a box", async () => {
  const { where, shell, asked } = await fixture();
  expect(readOnlyCommand("ps -e", where)).toBe(true);
  expect(routineCommand("ps -e", where)).toBe(true);
  expect(await shell.approve!("ps -e")).toBeUndefined();
  expect(asked).toEqual([]);
});

for (const command of ["git config --list", "git config -l", "git config --global --list"]) {
  test(`${command} asks instead of dumping potentially private settings`, async () => {
    const { where, shell, asked } = await fixture();
    expect(readOnlyCommand(command, where)).toBe(false);
    expect(routineCommand(command, where)).toBe(false);
    expect(await shell.approve!(command)).toBe(SHELL_DECLINED);
    expect(asked).toHaveLength(1);
  });
}

for (const [kind, key] of [
  ["credential", "credential.helper"],
  ["token", "service.apiToken"],
  ["password", "service.password"],
  ["extraheader", "http.https://example.com/.extraHeader"],
  ["url.*.insteadof", "url.https://example.com/.insteadOf"],
  ["url.*.pushinsteadof", "url.https://example.com/.pushInsteadOf"],
]) {
  test(`git config refuses keys naming ${kind} in every accepted read form`, async () => {
    const { where, shell, asked } = await fixture();
    for (const prefix of ["git config", "git config --get", "git config --get-all", "git config --global --get"]) {
      const command = `${prefix} ${key}`;
      expect(readOnlyCommand(command, where)).toBe(false);
      expect(routineCommand(command, where)).toBe(false);
      expect(await shell.approve!(command)).toBe(SHELL_DECLINED);
    }
    expect(asked).toHaveLength(4);
  });
}

test("ordinary process formats and individual public config reads stay unasked", async () => {
  const { where, shell, asked } = await fixture();
  for (const command of ["ps", "ps aux", "ps -ax -o pid,ppid,pcpu,etime,args", "ps -axo pid,etime,args", "ps axo pid,etime,args", "ps --sort=-pcpu -eo pid,args", "ps -o comm=NAME", "ps -ocomm=NAME", "ps --format=comm=NAME", "git config user.name", "git config --global --get user.email"]) {
    expect({ command, read: readOnlyCommand(command, where) }).toEqual({ command, read: true });
    expect(await shell.approve!(command)).toBeUndefined();
  }
  expect(asked).toEqual([]);
});
