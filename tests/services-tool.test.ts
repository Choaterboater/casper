import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CORE_PACK, NETWORK_PACK } from "../evals/packs";
import type { ServiceSpec } from "../src/services/config";
import { ServiceManager } from "../src/services/manager";
import { serviceRequested, serviceTool } from "../src/services/tool";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const SERVER = path.join(import.meta.dir, "fixtures", "service-server.ts");
const COMMAND = `"${process.execPath}" "${SERVER}"`;

async function until(condition: () => boolean | Promise<boolean>, deadline = 5000): Promise<void> {
  const limit = performance.now() + deadline;
  while (performance.now() < limit) { if (await condition()) return; await Bun.sleep(20); }
  throw new Error("Condition was not reached before its deadline");
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const gone = (pid: number) => until(() => !alive(pid));

async function fixture(spec: Partial<ServiceSpec> = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-service-tool-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"));
  const marker = path.join(root, "grandchild.pid");
  const manager = new ServiceManager({ projectRoot: root, services: {
    api: { command: COMMAND, port: "auto", ready: { http: "/health" }, timeoutMs: 10_000, scope: { inputs: ["src"] }, ...spec, env: { SPAWN_CHILD: marker, ...spec.env } },
  } });
  cleanups.push(() => manager.close().catch(() => {}));
  const tool = serviceTool(() => manager);
  /** The tool's text is the bounded envelope; its data is what the model reads. */
  const call = async (args: Record<string, unknown>) => {
    const result = await tool.execute(args, new AbortController().signal);
    const envelope = JSON.parse(result.text);
    return { isError: result.isError === true, text: result.text, data: envelope.data ?? envelope };
  };
  const grandchild = async () => { await until(async () => (await readFile(marker, "utf8").catch(() => "")).length > 0); return Number(await readFile(marker, "utf8")); };
  return { root, manager, tool, call, grandchild };
}

test("start, status, logs, restart and stop a declared service through the tool", async () => {
  const f = await fixture();
  expect(f.tool.name).toBe("service");
  const started = await f.call({ action: "start", service: "api" });
  expect(started.isError).toBe(false);
  expect(started.data.service).toMatchObject({ name: "api", state: "ready" });
  const origin: string = started.data.service.origin, first: number = started.data.service.pid;
  expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  const grandchild = await f.grandchild();
  expect((await f.call({ action: "status" })).data.services).toEqual([expect.objectContaining({ name: "api", state: "ready", origin })]);
  const logs = await f.call({ action: "logs", service: "api", filter: "listen" });
  expect(logs.data.logs).toBe("listening");
  const restarted = await f.call({ action: "restart", service: "api" });
  expect(restarted.data.service.state).toBe("ready");
  expect(restarted.data.service.pid).not.toBe(first);
  await gone(first); await gone(grandchild);
  const second: number = restarted.data.service.pid;
  const stopped = await f.call({ action: "stop", service: "api" });
  expect(stopped.data).toMatchObject({ stopped: true, service: { name: "api", state: "stopped" } });
  await gone(second);
  expect((await f.call({ action: "start", service: "nope" })).isError).toBe(true);
}, 30_000);

test("an ad-hoc service started by command is named adhoc-<n>, answers requests and stops with the session", async () => {
  const f = await fixture();
  const started = await f.call({ action: "start", command: COMMAND, ready: { log: "listening" } });
  expect(started.isError).toBe(false);
  expect(started.data.service).toMatchObject({ name: "adhoc-1", state: "ready", command: COMMAND });
  const pid: number = started.data.service.pid;
  const response = await f.call({ action: "request", service: "adhoc-1", method: "GET", path: "/health" });
  expect(response.data).toMatchObject({ service: "adhoc-1", status: 200, restarted: false });
  expect((await f.call({ action: "start", command: COMMAND })).data.service).toMatchObject({ name: "adhoc-1", pid });
  const second = await f.call({ action: "start", command: `${COMMAND} second` });
  expect(second.data.service.name).toBe("adhoc-2");
  await f.manager.close();
  await gone(pid); await gone(second.data.service.pid);
  expect(f.manager.status().map(service => [service.name, service.state])).toEqual([["api", "idle"], ["adhoc-1", "stopped"], ["adhoc-2", "stopped"]]);
}, 30_000);

test("requests reach only Casper's services and loopback; JSON is pretty-printed and bodies are bounded", async () => {
  const f = await fixture();
  for (const url of ["http://example.com/", "http://10.0.0.1:80/", "https://127.0.0.1/", "file:///etc/passwd", "http://127.0.0.1.example.com/"]) {
    const refused = await f.call({ action: "request", method: "GET", url });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("loopback");
  }
  const json = await f.call({ action: "request", service: "api", method: "GET", path: "/json" });
  expect(json.data).toMatchObject({ status: 200, restarted: false, headers: { "content-type": expect.stringContaining("application/json") } });
  expect(json.data.body).toBe(JSON.stringify({ items: [{ id: 1, title: "first" }], count: 1 }, null, 2));
  expect(typeof json.data.timeMs).toBe("number");
  const origin = f.manager.origin("api")!;
  const echoed = await f.call({ action: "request", method: "POST", url: `${origin}/echo`, headers: { "x-test": "yes" }, body: "payload" });
  expect(echoed.data).toMatchObject({ service: "api", status: 201 });
  expect(JSON.parse(echoed.data.body)).toEqual({ method: "POST", test: "yes", body: "payload" });
  const big = await f.call({ action: "request", service: "api", method: "GET", path: "/big" });
  expect(big.data.status).toBe(200);
  expect(big.data.body.startsWith("x".repeat(8192))).toBe(true);
  expect(big.data.body).toContain("[truncated: 20480 bytes, first 8192 shown]");
  expect(big.data.body.length).toBeLessThan(8300);
  expect(Buffer.byteLength(big.text)).toBeLessThanOrEqual(16_384);
}, 30_000);

test("a request after an in-scope edit restarts the service first and says so", async () => {
  const f = await fixture();
  const first = (await f.call({ action: "start", service: "api" })).data.service.pid as number;
  f.manager.markEdited("docs/readme.md");
  expect((await f.call({ action: "request", service: "api", method: "GET", path: "/health" })).data.restarted).toBe(false);
  f.manager.markEdited(path.join(f.root, "src", "app.ts"));
  const after = await f.call({ action: "request", service: "api", method: "GET", path: "/health" });
  expect(after.data).toMatchObject({ status: 200, restarted: true });
  await gone(first);
  expect(f.manager.status()[0]!.pid).not.toBe(first);
  expect((await f.call({ action: "request", service: "api", method: "GET", path: "/health" })).data.restarted).toBe(false);
}, 30_000);

test("a crash is reported with its exit code and log tail on the next call, once", async () => {
  const f = await fixture({ env: { CRASH_AFTER_MS: "400" } });
  await f.call({ action: "start", service: "api" });
  await until(() => f.manager.status()[0]!.state === "crashed");
  const next = await f.call({ action: "status" });
  expect(next.data.crashed).toEqual([expect.objectContaining({ name: "api", exit: { code: 3, signal: null }, tail: expect.stringContaining("fatal: synthetic crash") })]);
  expect((await f.call({ action: "status" })).data.crashed).toBeUndefined();
}, 30_000);

test("the tool is offered for declared or live services and server vocabulary, never for the benchmark prompts alone", () => {
  for (const task of [...CORE_PACK, ...NETWORK_PACK]) expect({ id: task.id, offered: serviceRequested(task.prompt, { declared: false, live: false }) }).toEqual({ id: task.id, offered: false });
  expect(serviceRequested("fix the parser", { declared: true, live: false })).toBe(true);
  expect(serviceRequested("fix the parser", { declared: false, live: true })).toBe(true);
  for (const text of ["start the dev server", "the HTTP server hangs", "our web-server crashes", "open localhost:3000", "add an endpoint", "curl it"]) {
    expect({ text, offered: serviceRequested(text, { declared: false, live: false }) }).toEqual({ text, offered: true });
  }
});

test("retrying an ad-hoc command reuses its slot, at most 4 ad-hoc services are kept, and 4 live ones refuse a fifth", async () => {
  const f = await fixture();
  const broken = `"${process.execPath}" -e "process.exit(4)"`;
  for (let attempt = 0; attempt < 3; attempt++) expect((await f.call({ action: "start", command: broken })).isError).toBe(true);
  expect(f.manager.names()).toEqual(["api", "adhoc-1"]);
  for (let other = 0; other < 6; other++) await f.call({ action: "start", command: `${broken} ${other}` });
  expect(f.manager.names().filter(name => name.startsWith("adhoc-")).length).toBe(4);
  const live = [];
  for (let n = 0; n < 4; n++) live.push((await f.call({ action: "start", command: `${COMMAND} live-${n}`, ready: { log: "listening" } })).data.service);
  expect(live.map(service => service.state)).toEqual(["ready", "ready", "ready", "ready"]);
  const fifth = await f.call({ action: "start", command: `${COMMAND} live-4`, ready: { log: "listening" } });
  expect(fifth.isError).toBe(true);
  expect(fifth.data.error).toContain("At most 4 ad-hoc services run at once");
  await f.manager.close();
  for (const service of live) await gone(service.pid);
}, 60_000);
