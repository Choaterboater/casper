import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { formatTerminalJSON } from "../src/tui/json";
import os from "node:os";
import path from "node:path";
import { DebugSession } from "../src/debug/session";
import { needsSymlinks } from "./support/platform";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const adapter = path.join(import.meta.dir, "fixtures/dap-adapter.ts");
async function fixture(confirm: (preview: string, signal: AbortSignal) => Promise<boolean> = async () => true, mode = "normal") {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-debug-")));
  cleanups.push(async () => {
    // Teardown fallback for a deliberately broken production cleanup in fault probes.
    const pid = Number(await readFile(path.join(root, "debuggee-pid"), "utf8").catch(() => "0"));
    if (pid > 0) { try { process.kill(-pid, "SIGKILL"); } catch {} }
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, ".casper"));
  await writeFile(path.join(root, "program.py"), "answer = 42\nprint(answer)\n");
  const target = { command: process.execPath, args: [adapter, mode], adapterID: "fixture", program: "program.py", breakpoints: { "program.py": [2] } };
  const config = path.join(root, ".casper/debug.json");
  await writeFile(config, JSON.stringify({ targets: { example: target } }));
  const session = new DebugSession({ projectRoot: root, confirm });
  cleanups.push(() => session.close());
  return { root, config, target, session };
}

test("DAP launch configures before awaiting launch, inspects stopped values and revokes old handles", async () => {
  const f = await fixture();
  expect(await f.session.run({ action: "start", target: "example" })).toMatchObject({ state: "stopped" });
  const requests = (await readFile(path.join(f.root, "requests.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line).command);
  expect(requests.slice(0, 4)).toEqual(["initialize", "launch", "setBreakpoints", "configurationDone"]);
  expect(await f.session.run({ action: "threads" })).toMatchObject({ items: [{ id: 1, name: "Main" }] });
  const stack = await f.session.run({ action: "stack", threadId: 1 });
  const frame = String(stack.items?.[0]?.handle);
  const scopes = await f.session.run({ action: "scopes", frame });
  const reference = String(scopes.items?.[0]?.handle);
  expect(await f.session.run({ action: "variables", reference })).toMatchObject({ items: [{ name: "answer", value: "42" }] });
  await f.session.run({ action: "continue", threadId: 1 });
  await Bun.sleep(30);
  await expect(f.session.run({ action: "variables", reference })).rejects.toThrow("handle");
  await expect(f.session.run({ action: "scopes", frame })).rejects.toThrow("handle");
  const pid = Number(await readFile(path.join(f.root, "debuggee-pid"), "utf8"));
  expect(() => process.kill(pid, 0)).not.toThrow();
  await f.session.close();
  expect(() => process.kill(pid, 0)).toThrow();
  expect(f.session.status().state).toBe("closed");
});

test("closing during an unresponsive approval revokes startup without waiting for the answer", async () => {
  let release!: (answer: boolean) => void;
  let entered!: () => void;
  const approval = new Promise<boolean>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture(async () => { entered(); return approval; });
  const launch = f.session.run({ action: "start", target: "example" });
  void launch.catch(() => {});
  await ready;
  const closing = f.session.close();
  const settled = await Promise.race([closing.then(() => true), Bun.sleep(300).then(() => false)]);
  release(true); await launch.catch(() => {}); await closing;
  expect(settled).toBe(true);
  expect(await Bun.file(path.join(f.root, "adapter-started")).exists()).toBe(false);
});

needsSymlinks("changed configuration, unsupported fields and redirected program paths cannot launch", async () => {
  const f = await fixture(async () => { await writeFile(f.config, JSON.stringify({ targets: { example: { ...f.target, programArgs: ["changed"] } } })); return true; });
  await expect(f.session.run({ action: "start", target: "example" })).rejects.toThrow("changed");
  expect(await Bun.file(path.join(f.root, "adapter-started")).exists()).toBe(false);
  await writeFile(f.config, JSON.stringify({ targets: { example: { ...f.target, attach: true } } }));
  await expect(f.session.run({ action: "start", target: "example" })).rejects.toThrow("Invalid");
  await symlink(adapter, path.join(f.root, "outside.py"));
  await writeFile(f.config, JSON.stringify({ targets: { example: { ...f.target, program: "outside.py" } } }));
  await expect(f.session.run({ action: "start", target: "example" })).rejects.toThrow("leaves the project");
});

test("protocol errors, unsupported adapters and cancellation drain startup without leaking processes", async () => {
  for (const mode of ["malformed", "unsupported", "hang"]) {
    const f = await fixture(async () => true, mode);
    const controller = new AbortController();
    const work = f.session.run({ action: "start", target: "example" }, controller.signal);
    if (mode === "hang") setTimeout(() => controller.abort(), 100);
    await expect(work).rejects.toThrow();
    await f.session.close();
    const pid = Number(await readFile(path.join(f.root, "adapter-started"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
    expect(f.session.status().ownedProcessCleanup).toBe("stopped");
  }
});

test("inspection results that cross stop epochs are rejected instead of reviving stale references", async () => {
  const f = await fixture(async () => true, "late");
  await f.session.run({ action: "start", target: "example" });
  const stack = await f.session.run({ action: "stack", threadId: 1 });
  const scopes = await f.session.run({ action: "scopes", frame: String(stack.items?.[0]?.handle) });
  await expect(f.session.run({ action: "variables", reference: String(scopes.items?.[0]?.handle) })).rejects.toThrow("changed");
});

test("debug values stay bounded after terminal escaping and raw provider diagnostics never escape", async () => {
  const f = await fixture(async () => true, "large");
  await f.session.run({ action: "start", target: "example" });
  const stack = await f.session.run({ action: "stack", threadId: 1 });
  const scopes = await f.session.run({ action: "scopes", frame: String(stack.items?.[0]?.handle) });
  const result = await f.session.run({ action: "variables", reference: String(scopes.items?.[0]?.handle) });
  expect(result.truncated).toBe(true);
  expect(Buffer.byteLength(formatTerminalJSON(result))).toBeLessThanOrEqual(16_384);
  expect(formatTerminalJSON(result)).not.toMatch(/[\x1b\x9b]/);
  const other = await fixture(async () => true, "error");
  await other.session.run({ action: "start", target: "example" });
  await expect(other.session.run({ action: "stack", threadId: 1 })).rejects.toThrow("Debugger request failed");
});

test("reverse requests cannot execute commands, and forged process IDs cannot kill unrelated processes", async () => {
  const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  cleanups.push(async () => { unrelated.kill("SIGKILL"); });
  const f = await fixture(async () => true, "reverse");
  await writeFile(f.config, JSON.stringify({ targets: { example: { ...f.target, args: [adapter, "reverse", String(unrelated.pid)] } } }));
  await f.session.run({ action: "start", target: "example" });
  expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();
  const reply = JSON.parse(await readFile(path.join(f.root, "reverse-response"), "utf8"));
  expect(reply).toMatchObject({ type: "response", command: "runInTerminal", success: false });
  expect(await Bun.file(path.join(f.root, "UNAUTHORIZED")).exists()).toBe(false);
  const pid = Number(await readFile(path.join(f.root, "debuggee-pid"), "utf8"));
  expect(() => process.kill(pid, 0)).not.toThrow();
  await f.session.close();
  expect(() => process.kill(pid, 0)).toThrow();
  expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();
});

test("an adapter ignoring disconnect cannot leave its TERM-resistant debuggee running", async () => {
  const f = await fixture(async () => true, "ignore-disconnect");
  await f.session.run({ action: "start", target: "example" });
  const pid = Number(await readFile(path.join(f.root, "debuggee-pid"), "utf8"));
  expect(() => process.kill(pid, 0)).not.toThrow();
  await f.session.close();
  expect(() => process.kill(pid, 0)).toThrow();
  expect(f.session.status().ownedProcessCleanup).toBe("stopped");
});

test("cancelling immediately after adapter launch drains its separately grouped debuggee", async () => {
  for (let repeat = 0; repeat < 8; repeat++) {
    const f = await fixture(async () => true, "hang-launch");
    const controller = new AbortController();
    const work = f.session.run({ action: "start", target: "example" }, controller.signal);
    void work.catch(() => {});
    const deadline = Date.now() + 3000;
    while (!await Bun.file(path.join(f.root, "debuggee-pid")).exists() && Date.now() < deadline) await Bun.sleep(5);
    const pid = Number(await readFile(path.join(f.root, "debuggee-pid"), "utf8"));
    expect(() => process.kill(pid, 0)).not.toThrow();
    controller.abort();
    await expect(work).rejects.toThrow();
    await f.session.close();
    expect(() => process.kill(pid, 0)).toThrow();
  }
}, 10_000);

test("debugger request deadlines are enforced without caller cancellation", async () => {
  const f = await fixture(async () => true, "hang");
  await expect(f.session.run({ action: "start", target: "example" })).rejects.toThrow("timed out");
  const pid = Number(await readFile(path.join(f.root, "adapter-started"), "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
  expect(f.session.status().state).toBe("failed");
}, 10_000);

test("debugger metadata and denied launch never start an adapter", async () => {
  let preview = "";
  const f = await fixture(async text => { preview = text; return false; });
  expect(await f.session.targets()).toEqual(["example"]);
  expect(f.session.status().state).toBe("idle");
  await expect(f.session.run({ action: "start", target: "example" })).rejects.toThrow("denied");
  expect(preview).toContain(f.root + "/program.py");
  expect(preview).toContain(process.execPath);
  expect(f.session.status().ownedAdapterPid).toBeUndefined();
  expect(await Bun.file(path.join(f.root, "adapter-started")).exists()).toBe(false);
});
