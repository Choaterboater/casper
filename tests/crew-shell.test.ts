import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { crewShell } from "../src/crew/shell";
import { linuxSandboxProblem } from "../src/sandbox/linux";
import { ShellSandbox } from "../src/sandbox/manager";
import { runtimeEngine } from "../src/sandbox/runtime";
import { SandboxStore } from "../src/sandbox/store";
import { needsSandbox } from "./support/platform";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function folders() {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-crew-shell-")));
  cleanup.push(() => rm(base, { recursive: true, force: true }));
  const home = path.join(base, "home"), main = path.join(base, "main"), copy = path.join(base, "copy"), state = path.join(base, "state");
  for (const folder of [home, main, copy, state]) await mkdir(folder, { recursive: true });
  return { home, main, copy, store: new SandboxStore(state) };
}

test("a builder's sandbox is rooted at its copy and never asks: a write elsewhere is refused, not asked", async () => {
  const { home, main, copy, store } = await folders();
  const asked: string[] = [];
  const sandbox = new ShellSandbox({ root: () => main, home, store, tempDirs: [], askHost: (host) => { asked.push(host); return Promise.resolve("session"); },
    askWrite: (targets) => { asked.push(...targets); return Promise.resolve(true); } });
  const copySandbox = sandbox.forCopy(copy);
  cleanup.push(() => copySandbox.close());
  expect(copySandbox.root).toBe(copy);
  expect(await copySandbox.decideWrite(main, "ai")).toBe("cant-ask");
  const notes: string[] = [];
  const shell = crewShell(sandbox, copy, (line) => notes.push(line))!;
  cleanup.push(() => shell.close());
  expect(await shell.outsideWrite!(path.join(main, "a.txt"))).toMatch(/^Not done/);
  expect(await shell.approve!("ssh build-server uptime")).toContain("Not run");
  expect(notes.join("\n")).toContain("build-server");
  expect(asked).toEqual([]);
});

needsSandbox("in the real sandbox a builder's command writes in its copy and can't write in your folder", async () => {
  const { home, main, copy, store } = await folders();
  const sandbox = new ShellSandbox({ root: () => main, home, store, tempDirs: [], engine: runtimeEngine(),
    problem: () => process.platform === "linux" ? linuxSandboxProblem() : undefined });
  cleanup.push(() => sandbox.close());
  const shell = crewShell(sandbox, copy, () => {})!;
  cleanup.push(() => shell.close());
  const run = async (command: string) => {
    const wrapped = await shell.wrap(command, copy);
    try { return spawnSync("sh", ["-c", wrapped.command], { cwd: copy, encoding: "utf8" }); }
    finally { if (wrapped.id) shell.finished!(wrapped.id); }
  };
  expect((await run("echo ok > made.txt")).status).toBe(0);
  expect(await readFile(path.join(copy, "made.txt"), "utf8")).toBe("ok\n");
  expect((await run(`echo no > '${path.join(main, "evil.txt")}'`)).status).not.toBe(0);
  expect(existsSync(path.join(main, "evil.txt"))).toBe(false);
});
