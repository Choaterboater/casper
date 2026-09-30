import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { receiptEvent } from "../src/app/json-events";
import { permissionsText } from "../src/app/commands";
import { runArgv } from "../src/network/run";
import { spawnTool } from "../src/new/scaffold";
import { ManagedProcess } from "../src/platform/managed-process";
import { casperBashOperations } from "../src/runtime/pi";
import { ShellSandbox, useSandbox } from "../src/sandbox/manager";
import { runTool } from "../src/security/spawn";
import { ServiceManager } from "../src/services/manager";
import { serviceTool } from "../src/services/tool";
import { formatReceipt, formatTaskResult, type TaskResult } from "../src/task/result";
import { runCommandCheck } from "../src/verify/command";
import { repairClass } from "../src/verify/evidence";
import { fakeEngine, type FakeEngine } from "./support/sandbox-fakes";
import { posixOnly } from "./support/platform";

/**
 * Every shell path asks the session's sandbox to wrap its command: checks, Casper's own tool runs, services and
 * dev servers, `uv`/`bun` in casper new, and the AI's bash. A fake engine records each wrap.
 */

const roots: string[] = [];
afterEach(async () => {
  useSandbox(undefined);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function session(options: { refuse?: (command: string) => string[]; noSandboxFlag?: boolean } = {}): Promise<{ root: string; engine: FakeEngine; sandbox: ShellSandbox }> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-sandbox-wiring-")));
  roots.push(root);
  const engine = fakeEngine(options.refuse);
  const sandbox = new ShellSandbox({ root: () => root, home: path.join(root, "home"), engine, problem: () => undefined, platform: "linux",
    ...(options.noSandboxFlag ? { noSandboxFlag: true } : {}) });
  useSandbox(sandbox);
  return { root, engine, sandbox };
}

posixOnly("a check runs in the sandbox, with the project's network rules", async () => {
  const { root, engine } = await session();
  const result = await runCommandCheck({ name: "test", command: "echo held=$CASPER_FAKE_HELD", cwd: root, timeoutMs: 10_000 });
  expect(result.status).toBe("pass");
  expect(result.stdout).toContain("held=ask");
  expect(result.command).toBe("echo held=$CASPER_FAKE_HELD");
  expect(engine.wrapped.map((entry) => entry.network)).toEqual(["ask"]);
});

posixOnly("a check the sandbox refused says so in the receipt, is never sent for repair, and the same line reaches the AI", async () => {
  // The fake sandbox lets it run; the folder does not exist, so it fails as the real sandbox would make it.
  const { root } = await session({ refuse: (command) => command.includes("/casper-no-such-dir/hosts") ? ["deny openat /casper-no-such-dir/hosts"] : [] });
  const result = await runCommandCheck({ name: "test", command: "echo 1.2.3.4 x >> /casper-no-such-dir/hosts", cwd: root, timeoutMs: 10_000 });
  expect(result.status).toBe("fail");
  expect(result.ended).toBe("blocked");
  expect(result.reason).toBe("blocked by the sandbox (wanted to write /casper-no-such-dir/hosts)");
  expect(repairClass(result)).toBe("never");
  const task: TaskResult = { execution: "completed", changedPaths: ["a.py"], verification: { status: "fail", results: [result], repairAttempts: 0 } as never };
  expect(formatReceipt(task)).toContain("✗ test — blocked by the sandbox (wanted to write /casper-no-such-dir/hosts)");
});

posixOnly("with --no-sandbox nothing is wrapped, and the receipt and JSON say so", async () => {
  const { root, engine, sandbox } = await session({ noSandboxFlag: true });
  const result = await runCommandCheck({ name: "test", command: "echo held=${CASPER_FAKE_HELD:-no}", cwd: root, timeoutMs: 10_000 });
  expect(result.stdout).toContain("held=no");
  expect(engine.wrapped).toEqual([]);
  expect(sandbox.state).toEqual({ kind: "off", reason: "--no-sandbox" });
  const task: TaskResult = { execution: "completed", changedPaths: [], sandbox: { held: false, reason: "--no-sandbox" } };
  expect(formatReceipt(task)).toContain("• Shell commands and checks were not sandboxed (--no-sandbox)");
  expect(receiptEvent(undefined, task, 0).sandbox).toEqual({ held: false, reason: "--no-sandbox" });
  expect(permissionsText(sandbox)).toContain("not sandboxed here (--no-sandbox)");
});

posixOnly("network checks and security tools run with no network; a lab run is never wrapped", async () => {
  const { root, engine } = await session();
  const offline = await runArgv("/bin/sh", ["-c", "echo held=$CASPER_FAKE_HELD"], { cwd: root, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 10_000 });
  expect(offline.stdout).toContain("held=none");
  const tool = await runTool({ file: "/bin/sh", args: ["-c", "echo held=$CASPER_FAKE_HELD"], cwd: root, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 10_000 });
  expect(tool.stdout).toContain("held=none");
  const lab = await runArgv("/bin/sh", ["-c", "echo held=${CASPER_FAKE_HELD:-no}"], { cwd: root, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 10_000, sandbox: false });
  expect(lab.stdout).toContain("held=no");
  expect(engine.wrapped.map((entry) => entry.network)).toEqual(["none", "none"]);
});

posixOnly("a missing program inside the sandbox is 'could not start', not a failure", async () => {
  const { root } = await session();
  const offline = await runArgv("casper-no-such-tool", [], { cwd: root, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 10_000 });
  expect(offline.ended).toBe("no_start");
  const tool = await runTool({ file: "casper-no-such-tool", args: [], cwd: root, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 10_000 });
  expect(tool.ended).toBe("no_start");
});

posixOnly("a service or dev server runs in the sandbox with the machine's own network, so the host can reach it", async () => {
  const { root, engine } = await session();
  const managed = new ManagedProcess({ command: "echo ready-$CASPER_FAKE_HELD; sleep 5", cwd: root, ready: { log: "ready-host" }, timeoutMs: 5_000 });
  await managed.start(new AbortController().signal);
  await managed.close();
  expect(engine.wrapped.map((entry) => entry.network)).toEqual(["host"]);
});

posixOnly("casper new runs uv and bun in the sandbox with the new folder writable; git runs as it is", async () => {
  const { root, engine } = await session();
  const folder = path.join(root, "new-project");
  await mkdir(folder);
  await spawnTool(["uv", "init"], { cwd: folder, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 10_000 });
  await spawnTool(["git", "--version"], { cwd: folder, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 10_000 });
  expect(engine.wrapped).toHaveLength(1);
  expect(engine.wrapped[0]!.command).toBe("uv init");
  expect(engine.wrapped[0]!.policy.allowWrite).toContain(folder);
  // uv may fetch a Python for the template; that place is not writable to other commands.
  expect(engine.wrapped[0]!.policy.allowWrite).toContain(path.join(os.homedir(), ".local/share/uv"));
});

posixOnly("the service tool refuses the same git commands as bash, and starts nothing", async () => {
  const { root, engine } = await session();
  const services = new ServiceManager({ projectRoot: root, services: {} });
  const tool = serviceTool(() => services);
  await expect(tool.execute({ action: "start", command: "git clean -fdx; sleep 600" }, new AbortController().signal))
    .resolves.toMatchObject({ isError: true, text: expect.stringContaining("Casper does not let the model run `git clean -fdx`") });
  expect(services.status()).toEqual([]);
  expect(engine.wrapped).toEqual([]);
  await services.close();
});

test("the AI's bash: the sandbox wraps it, and a refusal is added to what the AI reads", async () => {
  const ran: string[] = [];
  const local = { async exec(command: string, _cwd: string, options: { onData: (data: Buffer) => void }) {
    ran.push(command); options.onData(Buffer.from("Read-only file system\n")); return { exitCode: 1 };
  } };
  const shell = { wrap: async (command: string) => ({ command: `HELD ${command}`, id: "run-1" }),
    refused: async (id: string) => id === "run-1" ? "[sandbox] Blocked by the sandbox (wanted to write /etc/hosts)." : undefined };
  let output = "";
  const result = await casperBashOperations(shell, local).exec("echo x >> /etc/hosts", "/tmp", { onData: (data) => { output += data.toString(); } });
  expect(ran).toEqual(["HELD echo x >> /etc/hosts"]);
  expect(result.exitCode).toBe(1);
  expect(output).toContain("[sandbox] Blocked by the sandbox (wanted to write /etc/hosts).");
});

test("the AI's bash: a refused question runs nothing", async () => {
  const ran: string[] = [];
  const local = { async exec(command: string) { ran.push(command); return { exitCode: 0 }; } };
  const shell = { wrap: async (command: string) => ({ command }), approve: async () => "Not run: the user said no." };
  await expect(casperBashOperations(shell, local).exec("rm -rf build", "/tmp", { onData: () => {} })).rejects.toThrow("Not run: the user said no.");
  expect(ran).toEqual([]);
});

posixOnly("Pi's full-output log of a long command goes in Casper's private folder, not the shared temp folder", async () => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-shell-logs-")));
  roots.push(dir);
  let seen: string | undefined;
  const local = { async exec(_command: string, _cwd: string, options: { onData: (data: Buffer) => void }) { options.onData(Buffer.from("x")); return { exitCode: 0 }; } };
  const shell = { wrap: async (command: string) => ({ command }), logDir: async () => dir };
  await casperBashOperations(shell, local).exec("yes | head -100000", "/tmp", { onData: () => { seen = os.tmpdir(); } });
  expect(seen).toBe(dir);
  expect(os.tmpdir()).not.toBe(dir);
});

test("with the sandbox on, a receipt whose lab check ran says it ran outside the sandbox; a lab check that did not run says nothing", () => {
  const lab = { name: "aoscx-check", status: "pass", kind: "lab", label: "dry run not guaranteed", durationMs: 1000 };
  const ran: TaskResult = { execution: "completed", changedPaths: ["site.yml"], sandbox: { held: true },
    verification: { status: "pass", results: [lab], repairAttempts: 0 } as never };
  expect(formatReceipt(ran)).toContain("• Lab checks ran outside the sandbox (they log in to your lab devices with your own keys)");
  expect(formatTaskResult(ran)).toContain("shell commands and checks held; lab checks ran outside it (they log in to your lab devices with your own keys)");
  const skipped: TaskResult = { ...ran, verification: { status: "pass", results: [{ ...lab, status: "skip" }], repairAttempts: 0 } as never };
  expect(formatReceipt(skipped)).not.toContain("outside the sandbox");
  const plain: TaskResult = { ...ran, verification: { status: "pass", results: [{ name: "test", status: "pass", durationMs: 5 }], repairAttempts: 0 } as never };
  expect(formatReceipt(plain)).not.toContain("outside the sandbox");
});

posixOnly("when the sandbox fails to start on a check or a tool run, that run still goes ahead, not sandboxed, and the receipt says so", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-sandbox-wiring-")));
  roots.push(root);
  const failing = () => {
    const engine = { ...fakeEngine(), initialize: async () => { throw new Error("bwrap: setting up uid map: Permission denied"); } };
    const sandbox = new ShellSandbox({ root: () => root, home: path.join(root, "home"), engine, problem: () => undefined, platform: "linux" });
    useSandbox(sandbox);
    return sandbox;
  };
  const checkSandbox = failing();
  const first = await runCommandCheck({ name: "test", command: "echo ran", cwd: root, timeoutMs: 10_000 });
  expect({ status: first.status, ended: first.ended, out: first.stdout.trim() }).toEqual({ status: "pass", ended: undefined, out: "ran" });
  const { sandboxReceipt } = await import("../src/app/sandbox");
  expect(sandboxReceipt(checkSandbox)).toEqual({ held: false, reason: "the sandbox could not start: bwrap: setting up uid map: Permission denied" });
  await checkSandbox.close();
  const toolSandbox = failing();
  const tool = await runArgv("sh", ["-c", "echo tool"], { cwd: root, env: { PATH: process.env.PATH ?? "" }, timeoutMs: 10_000 });
  expect({ code: tool.exitCode, out: tool.stdout.trim() }).toEqual({ code: 0, out: "tool" });
  expect(sandboxReceipt(toolSandbox)?.held).toBe(false);
  await toolSandbox.close();
  const serviceSandbox = failing();
  const managed = new ManagedProcess({ command: "echo ready-${CASPER_FAKE_HELD:-plain}; sleep 5", cwd: root, ready: { log: "ready-plain" }, timeoutMs: 5_000 });
  await managed.start(new AbortController().signal);
  await managed.close();
  expect(sandboxReceipt(serviceSandbox)?.held).toBe(false);
  await serviceSandbox.close();
});

posixOnly("every held run tells the sandbox when it ended, so its stand-in files leave your project: checks, tool runs, services, casper new and the AI's bash", async () => {
  const { root, engine } = await session();
  await runCommandCheck({ name: "test", command: "true", cwd: root, timeoutMs: 10_000 });
  await runCommandCheck({ name: "lint", command: "exit 3", cwd: root, timeoutMs: 10_000 });
  await runArgv("sh", ["-c", "true"], { cwd: root, env: { PATH: process.env.PATH ?? "" }, timeoutMs: 10_000 });
  await runTool({ file: "sh", args: ["-c", "true"], cwd: root, env: { PATH: process.env.PATH ?? "" }, timeoutMs: 10_000 } as never);
  await spawnTool(["uv", "--version"], { cwd: root, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 10_000 });
  const managed = new ManagedProcess({ command: "echo ready; sleep 5", cwd: root, ready: { log: "ready" }, timeoutMs: 5_000 });
  await managed.start(new AbortController().signal);
  await managed.close();
  expect(engine.wrapped).toHaveLength(6);
  expect([...engine.ended].sort()).toEqual(engine.wrapped.map((entry) => entry.id).sort());

  const ended: string[] = [];
  const shell = { wrap: async (command: string) => ({ command, id: "bash-1" }), finished: (id: string) => { ended.push(id); } };
  const failing = { async exec(): Promise<{ exitCode: number }> { throw new Error("cut off"); } };
  await casperBashOperations(shell, { async exec() { return { exitCode: 0 }; } }).exec("true", root, { onData: () => {} });
  await expect(casperBashOperations(shell, failing).exec("true", root, { onData: () => {} })).rejects.toThrow("cut off");
  expect(ended).toEqual(["bash-1", "bash-1"]);
});

test("the runtime is told once per run it wrapped, never for Casper's own bubblewrap line or an unknown run", async () => {
  let cleanups = 0;
  const fakeRuntime = { SandboxManager: {
    initialize: async () => {}, wrapWithSandbox: async (command: string) => `wrapped ${command}`, cleanupAfterCommand: () => { cleanups++; },
    getSandboxViolationStore: () => ({ getViolationsForCommand: () => [] }), updateConfig: () => {}, reset: async () => {},
  } };
  const { runtimeEngine } = await import("../src/sandbox/runtime");
  const engine = runtimeEngine(async () => fakeRuntime as never, "darwin");
  const policy = { allowWrite: [], denyWrite: [], denyRead: [], allowedDomains: [] };
  await engine.initialize(policy, async () => false, {});
  await engine.wrap("true", policy, { id: "a", cwd: "/", network: "ask", prefix: "" });
  await engine.wrap("true", policy, { id: "b", cwd: "/", network: "ask", prefix: "" });
  engine.finished("a"); engine.finished("a"); engine.finished("unknown");
  expect(cleanups).toBe(1);
  engine.finished("b");
  expect(cleanups).toBe(2);
});
