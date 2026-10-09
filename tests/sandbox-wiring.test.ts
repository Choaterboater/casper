import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { receiptEvent } from "../src/app/json-events";
import { permissionsText } from "../src/app/commands";
import { runArgv } from "../src/network/run";
import { spawnTool } from "../src/new/scaffold";
import { ManagedProcess } from "../src/platform/managed-process";
import { casperBashOperations } from "../src/runtime/pi";
import { ShellSandbox, useSandbox, type SandboxWrapOptions } from "../src/sandbox/manager";
import { runTool } from "../src/security/spawn";
import { ServiceManager } from "../src/services/manager";
import { serviceTool } from "../src/services/tool";
import { formatReceipt, formatTaskResult, type TaskResult } from "../src/task/result";
import { runCommandCheck } from "../src/verify/command";
import { repairClass } from "../src/verify/evidence";
import { detectMigrations, type MigrationPlan } from "../src/verify/migrations";
import { VerifierRegistry } from "../src/verify/registry";
import { fakeEngine, type FakeEngine } from "./support/sandbox-fakes";
import { posixOnly } from "./support/platform";
import { removeTempDir } from "./support/temp-dir";

/**
 * Every shell path asks the session's sandbox to wrap its command: checks, Casper's own tool runs, services and
 * dev servers, `uv`/`bun` in casper new, and the AI's bash. A fake engine records each wrap.
 */

const roots: string[] = [];
afterEach(async () => {
  useSandbox(undefined);
  await Promise.all(roots.splice(0).map((root) => removeTempDir(root)));
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
  expect(formatReceipt(task)).toContain("– Shell commands and checks were not sandboxed (--no-sandbox)");
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

/** A Prisma + SQLite project whose node_modules prisma is a stand-in that writes what it was given to seen.txt. */
async function prismaProject(root: string): Promise<MigrationPlan> {
  const files: Record<string, string> = {
    "prisma/schema.prisma": 'datasource db {\n  provider = "sqlite"\n  url      = env("DATABASE_URL")\n}\n',
    "prisma/migrations/20240101_init/migration.sql": "CREATE TABLE sites (id INTEGER PRIMARY KEY);",
    ...(process.platform === "win32"
      ? { "node_modules/.bin/prisma.cmd": "@echo off\r\necho ran> \"%~dp0..\\..\\seen.txt\"\r\n" }
      : { "node_modules/.bin/prisma": "#!/bin/sh\necho \"held=${CASPER_FAKE_HELD:-no} $DATABASE_URL\" > \"$PWD/seen.txt\"\n" }),
  };
  for (const [name, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), text); }
  if (process.platform !== "win32") await chmod(path.join(root, "node_modules/.bin/prisma"), 0o755);
  return (await detectMigrations(root))!;
}

posixOnly("the migrations check runs the project's prisma in the sandbox, with no network", async () => {
  const { root, engine } = await session();
  const plan = await prismaProject(root);
  const [result] = await VerifierRegistry.forProject({ project: { root }, commands: {}, migrations: plan } as never).run(["migrations"]);
  expect(result!.status).toBe("pass");
  expect(await readFile(path.join(root, "seen.txt"), "utf8")).toMatch(/^held=none file:.*casper-migrations-[^/]+\/check\.db\n$/);
  expect(engine.wrapped.map((entry) => entry.network)).toEqual(["none"]);
  expect(engine.wrapped[0]!.command).toContain("migrate");
  expect(engine.ended).toEqual([engine.wrapped[0]!.id]);
});

test("with a sandbox holding commands, the migrations check starts the project's prisma only through it", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-sandbox-wiring-")));
  roots.push(root);
  const plan = await prismaProject(root);
  const wraps: Array<{ command: string; options: SandboxWrapOptions }> = [];
  const ended: string[] = [];
  // The stand-in sandbox runs nothing of the project's: it only records what it was asked to hold.
  useSandbox({ on: true, wrap: async (command: string, options: SandboxWrapOptions) => { wraps.push({ command, options }); return { command: "exit 0", id: "migrations-1", held: true }; },
    finished: (id: string) => { ended.push(id); } } as unknown as ShellSandbox);
  const [result] = await VerifierRegistry.forProject({ project: { root }, commands: {}, migrations: plan } as never).run(["migrations"]);
  expect(result!.status).toBe("pass");
  expect(existsSync(path.join(root, "seen.txt"))).toBe(false);
  expect(wraps).toHaveLength(1);
  expect(wraps[0]!.command).toContain("deploy");
  expect(wraps[0]!.options).toEqual({ cwd: root, network: "none" });
  expect(ended).toEqual(["migrations-1"]);
});

test("a migrations check the sandbox stopped says so in the receipt and is never sent for repair", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-sandbox-wiring-")));
  roots.push(root);
  const plan = await prismaProject(root);
  const ended: string[] = [];
  // The stand-in sandbox fails the command and reports what it refused, as the real one does when prisma reaches out.
  useSandbox({ on: true, wrap: async () => ({ command: "exit 1", id: "migrations-2", held: true }),
    blockedReason: (id: string) => id === "migrations-2" ? "blocked by the sandbox (wanted to reach binaries.prisma.sh)" : undefined,
    finished: (id: string) => { ended.push(id); } } as unknown as ShellSandbox);
  const [result] = await VerifierRegistry.forProject({ project: { root }, commands: {}, migrations: plan } as never).run(["migrations"]);
  expect(result!.status).toBe("fail");
  expect(result!.ended).toBe("blocked");
  expect(result!.reason).toBe("blocked by the sandbox (wanted to reach binaries.prisma.sh)");
  expect(repairClass(result!)).toBe("never");
  expect(ended).toEqual(["migrations-2"]);
  const task: TaskResult = { execution: "completed", changedPaths: ["prisma/schema.prisma"], verification: { status: "fail", results: [result!], repairAttempts: 0 } as never };
  expect(formatReceipt(task)).toContain("✗ migrations — blocked by the sandbox (wanted to reach binaries.prisma.sh)");
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

posixOnly("the service tool refuses a command that names ~/.ssh, and one that reaches another machine without your yes", async () => {
  const { root, engine } = await session();
  const services = new ServiceManager({ projectRoot: root, services: {} });
  const asked: string[] = [];
  const tool = serviceTool(() => services, undefined, undefined, async (command) => { asked.push(command); return "Not run: the user said no to reaching build-server."; });
  await expect(tool.execute({ action: "start", command: "cat ~/.ssh/config; sleep 600" }, new AbortController().signal))
    .resolves.toMatchObject({ isError: true, text: expect.stringContaining("Not run: this command reads ~/.ssh, which is private") });
  expect(asked).toEqual([]);
  await expect(tool.execute({ action: "start", command: "ssh -N -L 3000:localhost:3000 build-server" }, new AbortController().signal))
    .resolves.toMatchObject({ isError: true, text: expect.stringContaining("the user said no to reaching build-server") });
  expect(services.status()).toEqual([]);
  expect(engine.wrapped).toEqual([]);
  await services.close();
});

posixOnly("a service whose port is taken while you answer the sandbox question gets a new port and starts", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-sandbox-wiring-")));
  roots.push(root);
  const engine = { ...fakeEngine(), initialize: async () => { throw new Error("bwrap: setting up uid map: Permission denied"); } };
  useSandbox(new ShellSandbox({ root: () => root, home: path.join(root, "home"), engine, problem: () => undefined, platform: "linux" }));
  const services = new ServiceManager({ projectRoot: root, services: {} });
  const server = path.join(import.meta.dir, "fixtures", "service-server.ts");
  let taken: number | undefined;
  let other: ReturnType<typeof Bun.serve> | undefined;
  try {
    const started = await services.startCommand(`"${process.execPath}" "${server}"`, { ready: { http: "/health" }, timeoutMs: 10_000,
      approve: async () => {
        // Something else takes the port while the question is open.
        taken = Number(new URL(services.status()[0]!.origin!).port);
        other = Bun.serve({ hostname: "127.0.0.1", port: taken, fetch: () => new Response("not yours") });
        return undefined;
      } }, new AbortController().signal);
    expect(started.state).toBe("ready");
    expect(taken).toBeDefined();
    expect(new URL(started.origin!).port).not.toBe(String(taken));
  } finally {
    other?.stop(true);
    await services.close();
  }
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
  expect(formatReceipt(ran)).toContain("– Lab checks ran outside the sandbox (they log in to your lab devices with your own keys)");
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

posixOnly("when the sandbox fails to start on an ad-hoc service the AI started, it asks first, once per service; a declared service still goes ahead", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-sandbox-wiring-")));
  roots.push(root);
  const failing = () => {
    const engine = { ...fakeEngine(), initialize: async () => { throw new Error("bwrap: setting up uid map: Permission denied"); } };
    const sandbox = new ShellSandbox({ root: () => root, home: path.join(root, "home"), engine, problem: () => undefined, platform: "linux" });
    useSandbox(sandbox);
    return sandbox;
  };
  // No: nothing starts, and the AI reads why.
  let sandbox = failing();
  let services = new ServiceManager({ projectRoot: root, services: {} });
  const asked: string[] = [];
  const no = serviceTool(() => services, undefined, undefined, async (command) => {
    if (!sandbox.asksFirst) return undefined;
    asked.push(command); return "Not run: the user said no to this command.";
  });
  const command = "echo ready-${CASPER_FAKE_HELD:-plain} > started.txt; echo ready-plain; sleep 5";
  await expect(no.execute({ action: "start", command, ready: { log: "ready-plain" }, timeoutMs: 5_000 }, new AbortController().signal))
    .resolves.toMatchObject({ isError: true, text: expect.stringContaining("the user said no to this command") });
  expect(asked).toEqual([command]);
  expect(existsSync(path.join(root, "started.txt"))).toBe(false);
  await services.close();
  await sandbox.close();

  // Yes: it starts not sandboxed, and a restart after edits does not ask again.
  sandbox = failing();
  services = new ServiceManager({ projectRoot: root, services: {} });
  asked.length = 0;
  const yes = serviceTool(() => services, undefined, undefined, async (command) => {
    if (!sandbox.asksFirst) return undefined;
    asked.push(command); return undefined;
  });
  await expect(yes.execute({ action: "start", command, ready: { log: "ready-plain" }, timeoutMs: 5_000 }, new AbortController().signal))
    .resolves.not.toMatchObject({ isError: true });
  expect(asked).toEqual([command]);
  const name = services.status()[0]!.name;
  await services.restart(name, new AbortController().signal);
  expect(asked).toEqual([command]);
  await services.close();
  await sandbox.close();

  // A declared service is the project's own: it goes ahead not sandboxed, with no question.
  sandbox = failing();
  services = new ServiceManager({ projectRoot: root, services: { web: { command: "echo ready-plain; sleep 5", port: "auto", ready: { log: "ready-plain" }, timeoutMs: 5_000 } } });
  asked.length = 0;
  const declared = serviceTool(() => services, undefined, undefined, async (command) => { asked.push(command); return "Not run."; });
  await expect(declared.execute({ action: "start", service: "web" }, new AbortController().signal)).resolves.not.toMatchObject({ isError: true });
  expect(asked).toEqual([]);
  await services.close();
  await sandbox.close();
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
