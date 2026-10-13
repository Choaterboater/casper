import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { autoNamedChecks, modelNamedChecks, parseNamedChecks } from "../src/verify/named";
import { parseTerminalCheck } from "../src/verify/terminal-spec";
import { runTerminalCheck } from "../src/verify/terminal";
import { VerifierRegistry } from "../src/verify/registry";
import { VerificationTask } from "../src/verify/task";
import { processGone, waitForPid } from "./support/wait";
import { savedNamedCheck, saveNamedCheck } from "../src/project/config-write";
import type { ProjectModel } from "../src/project/model";
import { CasperApp } from "../src/app";
import type { CasperEvent } from "../src/app/json-events";
import { loadProjectContext } from "../src/project/context";
import { SkillRegistry } from "../src/skills/registry";
import type { AgentRuntime } from "../src/runtime/types";
import { removeTempDir } from "./support/temp-dir";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeTempDir(root); });
async function fixture() { const root = await mkdtemp(path.join(os.tmpdir(), "casper-terminal-tests-")); roots.push(root); return root; }
const python = Bun.which("python3");
const real = python && process.platform !== "win32" ? test : test.skip;
const scenario = (argv: string[], steps: unknown[], extra = {}) => parseTerminalCheck({ preset: "terminal", argv, steps, ...extra }, "verify.checks.cli");
const spec = () => scenario(["python3", "cli.py"], [{ expect: "Name?" }, { send: "Ada" }, { key: "enter" }, { expect: "Hello Ada" }]);

function model(root: string, namedChecks: ProjectModel["namedChecks"]): ProjectModel {
  return { schemaVersion: 1, project: { name: "fixture", root, git: false }, languages: [], frameworks: [], packageManager: null,
    commands: {}, namedChecks, architecture: {}, conventions: [], detectedAt: new Date().toISOString() };
}

test("terminal scenarios join ordinary named checks without changing network checks or defaults", () => {
  const parsed = parseNamedChecks({ cli: savedNamedCheck(spec()), syntax: { preset: "ansible-syntax", playbooks: ["site.yml"] }, optional: { ...savedNamedCheck(spec()), after: "ask" } });
  expect(parsed.cli).toEqual(spec());
  expect(parsed.syntax).toMatchObject({ kind: "offline", preset: "ansible-syntax", after: "each-change" });
  expect(autoNamedChecks(parsed)).toEqual(["cli", "syntax"]);
  expect(modelNamedChecks(parsed)).toEqual(["cli", "syntax", "optional"]);
  expect(() => parseNamedChecks({ test: savedNamedCheck(spec()) })).toThrow("cannot be typecheck");
  expect(() => parseNamedChecks(Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`cli-${i}`, savedNamedCheck(spec())])))).toThrow("at most 16");
});

test("terminal parsing rejects weak assertions, shells, hidden fields, lab kinds and unbounded input", () => {
  for (const value of [
    { argv: "python cli.py" }, { argv: ["python", "\0"] }, { argv: [] }, { steps: [{ send: "hello" }] },
    { steps: [{ expect: "ok", send: "yes" }] }, { steps: [{ key: "delete-system" }] }, { steps: [{ send: "hello\n" }, { expect: "ok" }] },
    { columns: 100000 }, { rows: 1 }, { exitCode: -1 }, { timeout: 0 }, { kind: "lab" }, { run: "echo ok" },
    { steps: [{ expect: "\x1b[2J" }] }, { scope: { inputs: ["../private"] } }, { steps: Array.from({ length: 25 }, () => ({ expect: "ok" })) },
  ]) expect(() => parseTerminalCheck({ ...savedNamedCheck(spec()), ...value }, "check")).toThrow();
});

test("unsupported Windows and a missing Python report not run, never a pass or an install", async () => {
  const options = { name: "cli", cwd: await fixture(), spec: spec(), timeoutMs: 1000 };
  expect(await runTerminalCheck({ ...options, platform: "win32", python: "must-not-start" })).toMatchObject({ status: "skip", repair: "never" });
  expect(await runTerminalCheck({ ...options, platform: "linux", python: null })).toMatchObject({ status: "skip", reason: expect.stringContaining("nothing was installed") });
});

real("a real terminal has TTY input/output, declared size, private provider-free environment, keys, assertions and exit evidence", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "cli.py"), `import os, sys\nassert sys.stdin.isatty() and sys.stdout.isatty()\nassert os.get_terminal_size().columns == 60\nassert os.get_terminal_size().lines == 12\nassert 'OPENAI_API_KEY' not in os.environ\nprint('Name?', flush=True)\nname = input()\nprint('Hello ' + name, flush=True)\n`);
  const terminal = scenario([python!, "cli.py"], spec().steps, { columns: 60, rows: 12 });
  const result = await runTerminalCheck({ name: "cli", cwd: root, spec: terminal, timeoutMs: 10_000, env: { ...process.env, OPENAI_API_KEY: "synthetic-provider-key" } });
  expect(result).toMatchObject({ status: "pass", exitCode: 0, label: "terminal · 60×12" });
  expect(result.stdout).toContain("Terminal check passed: 4 steps; exit 0");
  expect(result.stdout).toContain("Hello Ada");
  expect(result.command).toContain("cli.py");
  expect(result.command).not.toContain("driver.py");
});

real("cursor movement, erase and UTF-8 affect the current screen, not a raw-output substring", async () => {
  const root = await fixture();
  const argv = [python!, "-u", "-c", "import os; os.write(1, 'old\\r\\n\\x1b[2J\\x1b[Hnew café 界'.encode())"];
  expect(await runTerminalCheck({ name: "cli", cwd: root, spec: scenario(argv, [{ expect: "new café 界" }]), timeoutMs: 5000 })).toMatchObject({ status: "pass" });
  const erased = await runTerminalCheck({ name: "cli", cwd: root, spec: scenario(argv, [{ expect: "old" }]), timeoutMs: 5000 });
  expect(erased.status).toBe("fail");
  expect(erased.stdout).toContain("Terminal step 1/1 failed: missing screen text");
  expect(erased.stdout).toContain("SCREEN:\nnew café 界");
});

real("wide-glyph overwrites and right-margin cursor movement match visible cells", async () => {
  const root = await fixture();
  const wide = [python!, "-u", "-c", "import os; os.write(1, '界\\x1b[2GX'.encode())"];
  expect(await runTerminalCheck({ name: "cli", cwd: root, spec: scenario(wide, [{ expect: " X" }]), timeoutMs: 5000 })).toMatchObject({ status: "pass" });
  expect(await runTerminalCheck({ name: "cli", cwd: root, spec: scenario(wide, [{ expect: "界" }]), timeoutMs: 5000 })).toMatchObject({ status: "fail" });
  const margin = [python!, "-u", "-c", "import os; os.write(1, b'A'*20 + b'\\x1b[1DZ')"];
  expect(await runTerminalCheck({ name: "cli", cwd: root, spec: scenario(margin, [{ expect: "A".repeat(18) + "ZA" }], { columns: 20 }), timeoutMs: 5000 })).toMatchObject({ status: "pass" });
});

real("nonzero app exits fail even after all screen assertions passed", async () => {
  const root = await fixture();
  const argv = [python!, "-u", "-c", "print('done'); raise SystemExit(7)"];
  const result = await runTerminalCheck({ name: "cli", cwd: root, spec: scenario(argv, [{ expect: "done" }]), timeoutMs: 5000 });
  expect(result.status).toBe("fail");
  expect(result.stdout).toContain("expected exit 0, got 7");
  expect(await runTerminalCheck({ name: "cli", cwd: root, spec: scenario(argv, [{ expect: "done" }], { exitCode: 7 }), timeoutMs: 5000 })).toMatchObject({ status: "pass" });
});

real("a bounded timeout reports the failing step and current screen", async () => {
  const result = await runTerminalCheck({ name: "cli", cwd: await fixture(), spec: scenario([python!, "-u", "-c", "import time; print('waiting'); time.sleep(30)"], [{ expect: "never appears" }]), timeoutMs: 2000 });
  expect(result).toMatchObject({ status: "fail", ended: "timeout" });
  expect(result.stdout).toContain("Terminal step 1/1 failed");
  expect(result.stdout).toContain("SCREEN:\nwaiting");
});

real("a control-C is a physical terminal key and the app can handle it", async () => {
  const argv = [python!, "-u", "-c", "import signal,time; signal.signal(signal.SIGINT, lambda *_: (print('bye',flush=True),exit(0))); print('ready',flush=True); time.sleep(30)"];
  const result = await runTerminalCheck({ name: "cli", cwd: await fixture(), spec: scenario(argv, [{ expect: "ready" }, { key: "ctrl-c" }, { expect: "bye" }]), timeoutMs: 5000 });
  expect(result.status).toBe("pass");
});

real("unsupported VT operations cannot silently pass a screen check", async () => {
  const argv = [python!, "-u", "-c", "print('\\x1b[999zdone')"];
  const result = await runTerminalCheck({ name: "cli", cwd: await fixture(), spec: scenario(argv, [{ expect: "done" }]), timeoutMs: 5000 });
  expect(result).toMatchObject({ status: "skip", repair: "never" });
});

real("incomplete escapes, image commands and unmodelled Unicode cannot silently pass", async () => {
  for (const output of ["ready\x1b[", "ready\x1b]1337;File=data\x07", "ready\u200d"]) {
    const argv = [python!, "-u", "-c", `import os; os.write(1, ${JSON.stringify(output)}.encode())`];
    expect(await runTerminalCheck({ name: "cli", cwd: await fixture(), spec: scenario(argv, [{ expect: "ready" }]), timeoutMs: 5000 })).toMatchObject({ status: "skip", repair: "never" });
  }
});

real("program arguments are never interpreted as a shell command", async () => {
  const root = await fixture();
  const literal = "$(touch SHOULD_NOT_EXIST)";
  const argv = [python!, "-u", "-c", "import sys; print(sys.argv[1])", literal];
  const result = await runTerminalCheck({ name: "cli", cwd: root, spec: scenario(argv, [{ expect: literal }]), timeoutMs: 5000 });
  expect(result.status).toBe("pass");
  expect(Bun.file(path.join(root, "SHOULD_NOT_EXIST")).size).toBe(0);
  expect(await Bun.file(path.join(root, "SHOULD_NOT_EXIST")).exists()).toBe(false);
});

real("managed registration freezes scenarios, routes through the check wrapper and exposes receipt evidence", async () => {
  const root = await fixture();
  const terminal = scenario([python!, "-u", "-c", "print('ready')"], [{ expect: "ready" }]);
  let wraps = 0;
  const registry = VerifierRegistry.forProject(model(root, { cli: terminal }), 5000, undefined, { wrap: plan => { wraps++; return plan; } });
  terminal.steps = [{ expect: "changed after registration" }];
  expect(registry.modelNames()).toContain("cli");
  expect(registry.command("cli")).toContain("ready");
  const [result] = await registry.run(["cli"]);
  expect(result).toMatchObject({ name: "cli", status: "pass", label: "terminal · 80×24" });
  expect(wraps).toBe(1);
});

real("changing only the screen expectations invalidates a managed pass with the same program and files", async () => {
  const root = await fixture();
  const argv = [python!, "-u", "-c", "print('ready')"];
  const before = VerifierRegistry.forProject(model(root, { cli: scenario(argv, [{ expect: "ready" }], { scope: { inputs: ["."] } }) }), 5000);
  const task = new VerificationTask(before, root);
  try {
    const [pass] = await task.run(["cli"]);
    expect(pass).toMatchObject({ status: "pass", freshness: "fresh" });
    const after = VerifierRegistry.forProject(model(root, { cli: scenario(argv, [{ expect: "not ready" }], { scope: { inputs: ["."] } }) }), 5000);
    expect(after.command("cli")).not.toBe(before.command("cli"));
    task.useRegistry(after);
    const [fail] = await task.run(["cli"]);
    expect(fail?.status).toBe("fail");
    expect(fail?.reused).not.toBe(true);
  } finally { await task.close(); }
});

real("cancelling a terminal check stops its app and reports cancellation, not a pass", async () => {
  const root = await fixture();
  const pidFile = path.join(root, "app.pid");
  const argv = [python!, "-u", "-c", "import os,pathlib,subprocess,sys,time; child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)']); pathlib.Path('app.pid').write_text(str(os.getpid())); pathlib.Path('child.pid').write_text(str(child.pid)); print('ready'); time.sleep(30)"];
  const controller = new AbortController();
  const pending = runTerminalCheck({ name: "cli", cwd: root, spec: scenario(argv, [{ expect: "never" }]), timeoutMs: 10_000, signal: controller.signal });
  const pid = await waitForPid(pidFile, 5000);
  const child = await waitForPid(path.join(root, "child.pid"), 5000);
  expect(pid).toBeGreaterThan(0);
  expect(child).toBeGreaterThan(0);
  controller.abort();
  expect(await pending).toMatchObject({ status: "fail", reason: "Verification cancelled" });
  expect(await processGone(pid)).toBe(true);
  expect(await processGone(child)).toBe(true);
});

real("normal exit closes descendant processes instead of waiting for their inherited terminal", async () => {
  const root = await fixture();
  const argv = [python!, "-u", "-c", "import pathlib,subprocess,sys; child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)']); pathlib.Path('child.pid').write_text(str(child.pid)); print('done')"];
  const result = await runTerminalCheck({ name: "cli", cwd: root, spec: scenario(argv, [{ expect: "done" }]), timeoutMs: 5000 });
  expect(result).toMatchObject({ status: "pass" });
  const child = await waitForPid(path.join(root, "child.pid"));
  expect(child).toBeGreaterThan(0);
  expect(await processGone(child)).toBe(true);
});

real("a missing or nonexecutable app is not started and never passed", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "not-executable"), "not a program", { mode: 0o600 });
  for (const name of ["does-not-exist", "not-executable"]) {
    expect(await runTerminalCheck({ name: "cli", cwd: root, spec: scenario([path.join(root, name)], [{ expect: "ready" }]), timeoutMs: 5000 }))
      .toMatchObject({ status: "fail", ended: "no_start", repair: "never" });
  }
});

real("a missing runner report never counts as terminal evidence", async () => {
  const result = await runTerminalCheck({ name: "cli", cwd: await fixture(), spec: spec(), timeoutMs: 5000,
    wrap: () => ({ file: python!, args: ["-c", "pass"], shell: false }) });
  expect(result).toMatchObject({ status: "skip", repair: "never", reason: expect.stringContaining("no scenario evidence") });
});

real("/verify loads the declared PTY scenario and emits a managed check without a model request", async () => {
  const root = await fixture();
  const home = path.join(root, "home");
  await mkdir(path.join(root, ".casper"));
  await mkdir(home);
  await writeFile(path.join(root, "cli.py"), "name = input('Name? ')\nprint('Hello ' + name)\n");
  await writeFile(path.join(root, ".casper/project.yaml"), `verify:\n  checks:\n    cli:\n      preset: terminal\n      argv: [${JSON.stringify(python)}, cli.py]\n      steps:\n        - expect: 'Name?'\n        - send: 'Ada'\n        - key: enter\n        - expect: 'Hello Ada'\n`);
  const events: CasperEvent[] = [];
  let output = "";
  const runtime: AgentRuntime = { async start() { throw new Error("A /verify command must not request a model"); }, async dispose() {} };
  const app = new CasperApp({
    runtimeFactory: () => runtime, sessionHomeDir: home,
    loadProjectContext: info => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: context => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
    output: { write(chunk: string) { output += chunk; return true; } } as never,
    onEvent: event => { events.push(event); },
  });
  try {
    await app.runOnce("/verify cli", root);
    expect(output).toContain("cli passed");
    expect(events.find(event => event.type === "check")).toMatchObject({ type: "check", name: "cli", status: "pass", label: "terminal · 80×24" });
  } finally { await app.close(); }
});

test("a saved terminal scenario round-trips every step and viewport setting", async () => {
  const root = await fixture();
  const terminal = scenario(["python3", "cli.py"], spec().steps, { columns: 100, rows: 30, exitCode: 2 });
  expect(savedNamedCheck(terminal)).toMatchObject({ argv: terminal.argv, steps: terminal.steps, columns: 100, rows: 30, exitCode: 2 });
  await saveNamedCheck(root, "cli", terminal);
  expect(await readFile(path.join(root, ".casper/project.yaml"), "utf8")).toContain("preset: terminal");
});
