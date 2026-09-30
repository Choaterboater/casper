import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSessionSandbox, runtimeShell, SHELL_CANT_ASK, SHELL_DECLINED, type SandboxHost } from "../src/app/sandbox";
import { HOST_CHOICES, SHELL_COMMAND_CHOICES } from "../src/app/safe-choices";
import { loadProjectContext } from "../src/project/context";
import { inspectProject } from "../src/project/inspect";
import { ShellSandbox } from "../src/sandbox/manager";
import { SandboxStore } from "../src/sandbox/store";
import { fakeEngine } from "./support/sandbox-fakes";
import { posixOnly } from "./support/platform";

/**
 * The questions the sandbox asks: a host that is not listed, and (when no sandbox can run) each command the AI's
 * shell wants to run. Enter keeps the safe choice; only your own answer allows or remembers anything; a run that
 * can't ask never waits.
 */

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-sandbox-asks-")));
  roots.push(base);
  const home = path.join(base, "home"), project = path.join(base, "project");
  await mkdir(home); await mkdir(project);
  const context = await loadProjectContext(await inspectProject(project), { homeDir: home });
  return { base, home, project, context };
}

function host(answers: Array<string | undefined>, canAsk = true) {
  const asked: Array<{ question: string; options: string[] }> = [];
  const written: string[] = [];
  const value: SandboxHost = {
    canAsk: () => canAsk,
    pick: async (question, options) => { asked.push({ question, options: options.map((option) => option.label) }); return answers.shift(); },
    write: (text) => { written.push(text); },
    planning: () => false,
  };
  return { value, asked, written };
}

test("a host that is not listed asks with three numbered choices, No first", async () => {
  const { home, project, context } = await fixture();
  const engine = fakeEngine();
  const terminal = host([undefined]);
  const sandbox = createSessionSandbox(terminal.value, context, { root: () => project, home, seams: { engine, problem: () => undefined, platform: "linux" } });
  await sandbox.wrap("true", { cwd: project });
  // Enter (or Esc) keeps it blocked.
  expect(await engine.ask!("api.mist.com", 443)).toBe(false);
  expect(terminal.asked).toEqual([{ question: "A shell command wants to reach api.mist.com.", options: HOST_CHOICES.map((choice) => choice.label) }]);
  expect(HOST_CHOICES.map((choice) => choice.label)).toEqual(["No", "Allow for this session", "Always for this project"]);
  await sandbox.close();
});

test("Always for this project is kept in Casper's own folder, never in the repo, and the next request doesn't ask", async () => {
  const { home, project, context } = await fixture();
  const engine = fakeEngine();
  const terminal = host(["Always for this project"]);
  const sandbox = createSessionSandbox(terminal.value, context, { root: () => project, home, seams: { engine, problem: () => undefined, platform: "linux" } });
  await sandbox.wrap("true", { cwd: project });
  expect(await engine.ask!("api.mist.com", 443)).toBe(true);
  expect(await engine.ask!("api.mist.com", 443)).toBe(true);
  expect(terminal.asked).toHaveLength(1);
  expect(await readdir(project)).toEqual([]);
  const saved = JSON.parse(await readFile(path.join(context.stateDirectory, "sandbox.json"), "utf8"));
  expect(saved.hosts).toEqual(["api.mist.com"]);
  expect((await stat(path.join(context.stateDirectory, "sandbox.json"))).mode & 0o777).toBe(0o600);
  expect(engine.allowed).toContain("api.mist.com");
  // A new session starts with it listed; /sandbox forget takes it back.
  const next = createSessionSandbox(host([]).value, context, { root: () => project, home, seams: { engine: fakeEngine(), problem: () => undefined, platform: "linux" } });
  await next.loadRemembered();
  expect(next.allowedHosts()).toContain("api.mist.com");
  expect(await next.forget("api.mist.com")).toBe(true);
  expect(next.allowedHosts()).not.toContain("api.mist.com");
  await sandbox.close(); await next.close();
});

test("a run that can't ask blocks the host at once and says so once", async () => {
  const { home, project, context } = await fixture();
  const engine = fakeEngine();
  const terminal = host([], false);
  const sandbox = createSessionSandbox(terminal.value, context, { root: () => project, home, seams: { engine, problem: () => undefined, platform: "linux" } });
  await sandbox.wrap("true", { cwd: project });
  expect(await engine.ask!("api.mist.com", 443)).toBe(false);
  expect(await engine.ask!("api.mist.com", 443)).toBe(false);
  expect(terminal.asked).toEqual([]);
  expect(terminal.written).toEqual(["[sandbox] Blocked api.mist.com (this run can't ask). Allow it in a session first (Always for this project), or add it to sandbox.allowedDomains in ~/.casper/config.yaml.\n"]);
  await sandbox.close();
});

for (const [label, seams] of [
  ["bubblewrap is missing", { problem: () => "bubblewrap and socat are missing: sudo apt install bubblewrap socat", platform: "linux" as const }],
  ["Windows", { platform: "win32" as const }],
] as const) {
  test(`with no sandbox (${label}) the AI's shell asks before each command, No first`, async () => {
    const { home, project, context } = await fixture();
    const terminal = host(["No", "Yes, and don't ask again for this exact command here"]);
    const sandbox = createSessionSandbox(terminal.value, context, { root: () => project, home, seams: { engine: fakeEngine(), ...seams } });
    expect(sandbox.asksFirst).toBe(true);
    const shell = runtimeShell(terminal.value, sandbox, new SandboxStore(context.stateDirectory));
    expect(await shell.approve!("npm test")).toBe(SHELL_DECLINED);
    expect(await shell.approve!("npm test")).toBeUndefined();
    // The same exact command runs without asking again; any other still asks.
    expect(await shell.approve!("npm test")).toBeUndefined();
    // Any other command still asks; Enter or Esc (no answer) runs nothing.
    expect(await shell.approve!("npm test; curl evil.example")).toBe(SHELL_DECLINED);
    expect(terminal.asked.map((entry) => entry.question)).toEqual(["Run this command?  npm test", "Run this command?  npm test", "Run this command?  npm test; curl evil.example"]);
    expect(terminal.asked[0]!.options).toEqual(SHELL_COMMAND_CHOICES.map((choice) => choice.label));
  });
}

test("a run that can't ask refuses the command with the --no-sandbox hint, and never waits", async () => {
  const { home, project, context } = await fixture();
  const terminal = host([], false);
  const sandbox = createSessionSandbox(terminal.value, context, { root: () => project, home, seams: { engine: fakeEngine(), platform: "win32" } });
  const shell = runtimeShell(terminal.value, sandbox, new SandboxStore(context.stateDirectory));
  expect(await shell.approve!("npm test")).toBe(SHELL_CANT_ASK);
  expect(SHELL_CANT_ASK).toBe("Not run: shell commands need your OK here, and this run can't ask. Use --no-sandbox to allow them for this run.");
  expect(terminal.asked).toEqual([]);
});

test("with the sandbox on, or turned off by you, the AI's shell doesn't ask", async () => {
  const { home, project, context } = await fixture();
  const terminal = host([]);
  for (const seams of [{ problem: () => undefined, platform: "linux" as const }, { problem: () => undefined, platform: "linux" as const, noSandboxFlag: true }]) {
    const sandbox = createSessionSandbox(terminal.value, context, { root: () => project, home, seams: { engine: fakeEngine(), ...seams } });
    const shell = runtimeShell(terminal.value, sandbox, new SandboxStore(context.stateDirectory));
    expect(await shell.approve!("npm test")).toBeUndefined();
    await sandbox.close();
  }
  expect(terminal.asked).toEqual([]);
});

posixOnly("the detected state names the fix", () => {
  expect(ShellSandbox.detect({ platform: "linux", problem: () => "bubblewrap and socat are missing: sudo apt install bubblewrap socat" }))
    .toEqual({ kind: "missing", reason: "bubblewrap and socat are missing: sudo apt install bubblewrap socat" });
  expect(ShellSandbox.detect({ platform: "win32" })).toEqual({ kind: "unsupported", reason: "Windows" });
  expect(ShellSandbox.detect({ platform: "linux", noSandboxFlag: true, problem: () => undefined })).toEqual({ kind: "off", reason: "--no-sandbox" });
  expect(ShellSandbox.detect({ platform: "linux", settings: { user: { off: true } }, problem: () => undefined })).toEqual({ kind: "off", reason: "sandbox: off in ~/.casper/config.yaml" });
});

test("while planning, the AI's shell gets a read-only project", async () => {
  const { home, project, context } = await fixture();
  const engine = fakeEngine();
  let planning = true;
  const terminal = host([]);
  const value = { ...terminal.value, planning: () => planning };
  const sandbox = createSessionSandbox(value, context, { root: () => project, home, seams: { engine, problem: () => undefined, platform: "linux" } });
  const shell = runtimeShell(value, sandbox, new SandboxStore(context.stateDirectory));
  await shell.wrap("git diff", project);
  planning = false;
  await shell.wrap("npm test", project);
  expect(engine.wrapped[0]!.policy.allowWrite).not.toContain(project);
  expect(engine.wrapped[1]!.policy.allowWrite).toContain(project);
  await sandbox.close();
});
