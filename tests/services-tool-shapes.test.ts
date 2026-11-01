import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import os from "node:os";
import path from "node:path";
import { ShellSandbox, useSandbox } from "../src/sandbox/manager";
import type { ServiceSpec } from "../src/services/config";
import { ServiceManager } from "../src/services/manager";
import { serviceTool } from "../src/services/tool";
import { reapMarker } from "./support/reap";
import { fakeEngine } from "./support/sandbox-fakes";
import { posixOnly } from "./support/platform";
import { removeTempDir } from "./support/temp-dir";

/**
 * The service tool as a small model calls it (the shapes Haiku sent in a real build): every reasonable shape reaches
 * the service, a wrong one says the right call, and a restarted service keeps its address.
 */

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); useSandbox(undefined); });

const SERVER = path.join(import.meta.dir, "fixtures", "service-server.ts");
const COMMAND = `"${process.execPath}" "${SERVER}"`;

async function fixture(spec: Partial<ServiceSpec> = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-service-shapes-")));
  cleanups.push(() => removeTempDir(root));
  await mkdir(path.join(root, "src"));
  const marker = path.join(root, "grandchild.pid");
  const manager = new ServiceManager({ projectRoot: root, services: {
    api: { command: COMMAND, port: "auto", ready: { http: "/health" }, timeoutMs: 10_000, scope: { inputs: ["src"] }, ...spec, env: { SPAWN_CHILD: marker, ...spec.env } },
  } });
  cleanups.push(() => reapMarker(marker));
  cleanups.push(() => manager.close().catch(() => {}));
  const tool = serviceTool(() => manager);
  const call = async (args: Record<string, unknown>) => {
    const result = await tool.execute(args, new AbortController().signal);
    const envelope = JSON.parse(result.text);
    return { isError: result.isError === true, text: result.text, data: envelope.data ?? envelope };
  };
  return { root, manager, call };
}

test("the shapes a small model sends reach the service: a nested request, a url path, name or id for service, the name it chose", async () => {
  const f = await fixture();
  // It names its own service "app"; Casper keeps the slot's name and answers to both.
  const started = await f.call({ action: "start", name: "app", command: COMMAND, ready: { log: "listening" } });
  expect(started.isError).toBe(false);
  expect(started.data.service).toMatchObject({ name: "adhoc-1", alias: "app", state: "ready" });
  const nested = await f.call({ action: "request", service: "app", request: { method: "GET", path: "/json" } });
  expect(nested.isError).toBe(false);
  expect(nested.data).toMatchObject({ service: "adhoc-1", status: 200 });
  expect((await f.call({ action: "request", service: "adhoc-1", url: "/health" })).data).toMatchObject({ status: 200 });
  expect((await f.call({ action: "request", name: "app", method: "GET", path: "/health" })).data).toMatchObject({ status: 200 });
  for (const args of [{ action: "logs", id: "adhoc-1", lines: 5 }, { action: "logs", name: "app" }, { action: "restart", name: "adhoc-1" }]) {
    expect({ args, isError: (await f.call(args)).isError }).toEqual({ args, isError: false });
  }
  const stopped = await f.call({ action: "stop", name: "app" });
  expect(stopped.data).toMatchObject({ stopped: true, service: { name: "adhoc-1", state: "stopped" } });
}, 30_000);

test("a request to a name nobody has goes to the only running service and says so; with none running the error shows the call", async () => {
  const f = await fixture();
  await f.call({ action: "start", command: COMMAND, ready: { log: "listening" } });
  const guessed = await f.call({ action: "request", service: "web", method: "GET", path: "/health" });
  expect(guessed.isError).toBe(false);
  expect(guessed.data).toMatchObject({ service: "adhoc-1", status: 200 });
  expect(guessed.data.note).toContain("adhoc-1");
  await f.call({ action: "stop", service: "adhoc-1" });
  const none = await f.call({ action: "request", service: "web", method: "GET", path: "/health" });
  expect(none.isError).toBe(true);
  expect(none.data.error).toContain('{"action":"request","service":"');
}, 30_000);

test("a missing field is named with the call that works", async () => {
  const f = await fixture();
  await f.call({ action: "start", service: "api" });
  await f.call({ action: "start", command: COMMAND, ready: { log: "listening" } });
  const noPath = await f.call({ action: "request", service: "api", method: "GET" });
  expect(noPath.isError).toBe(true);
  expect(noPath.data.error).toContain('{"action":"request","service":"api","method":"GET","path":"/"}');
  // Two running and none named: which one is the person's call, so the error shows it.
  const noService = await f.call({ action: "restart" });
  expect(noService.data.error).toContain('{"action":"restart","service":"api"}');
}, 30_000);

test("a restarted service keeps its address; parallel requests after an edit restart it once", async () => {
  const f = await fixture();
  const origin = (await f.call({ action: "start", service: "api" })).data.service.origin as string;
  for (let round = 0; round < 3; round++) {
    const again = await f.call({ action: "restart", service: "api" });
    expect(again.data.service.origin).toBe(origin);
    expect(again.data.moved).toBeUndefined();
  }
  f.manager.markEdited(path.join(f.root, "src", "app.ts"));
  const answers = await Promise.all([0, 1, 2, 3].map(() => f.call({ action: "request", service: "api", method: "GET", path: "/health" })));
  expect(answers.map(answer => [answer.isError, answer.data.status])).toEqual([[false, 200], [false, 200], [false, 200], [false, 200]]);
  expect(answers.filter(answer => answer.data.restarted).length).toBe(1);
  expect(f.manager.origin("api")).toBe(origin);
}, 30_000);

test("a service whose port something else took moves, and the result says so loudly", async () => {
  const f = await fixture();
  const origin = (await f.call({ action: "start", service: "api" })).data.service.origin as string;
  await f.call({ action: "stop", service: "api" });
  const port = Number(new URL(origin).port);
  const squatter: Server = createServer();
  await new Promise<void>((resolve) => squatter.listen(port, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => squatter.close(resolve)));
  const moved = await f.call({ action: "start", service: "api" });
  expect(moved.isError).toBe(false);
  expect(moved.data.service.origin).not.toBe(origin);
  expect(moved.data.moved).toContain(origin);
  expect(moved.data.moved).toContain(moved.data.service.origin);
  // Said once.
  expect((await f.call({ action: "status" })).data.moved).toBeUndefined();
}, 30_000);

posixOnly("a host the sandbox kept a service from reaching is named in the tool result, once, as not the app's fault", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-service-blocked-")));
  cleanups.push(() => removeTempDir(root));
  // The app reaches out only once it serves a request: from then on the sandbox has refused that host.
  let reached = false;
  const engine = fakeEngine();
  engine.violations = () => reached ? ["deny(1) network-outbound api.open-meteo.com:443"] : [];
  const sandbox = new ShellSandbox({ root: () => root, home: path.join(root, "home"), engine, problem: () => undefined, platform: "linux" });
  useSandbox(sandbox);
  cleanups.push(() => sandbox.close());
  const manager = new ServiceManager({ projectRoot: root, services: {} });
  cleanups.push(() => manager.close().catch(() => {}));
  const tool = serviceTool(() => manager);
  const call = async (args: Record<string, unknown>) => JSON.parse((await tool.execute(args, new AbortController().signal)).text).data;
  expect((await call({ action: "start", command: COMMAND, ready: { log: "listening" } })).blocked).toBeUndefined();
  reached = true;
  const answer = await call({ action: "request", service: "adhoc-1", method: "GET", path: "/health" });
  expect(answer.status).toBe(200);
  expect(answer.blocked).toContain("api.open-meteo.com");
  expect(answer.blocked).toContain("not");
  expect((await call({ action: "status" })).blocked).toBeUndefined();
}, 30_000);

posixOnly("a sandboxed command's node fetch is told to use the sandbox's proxy, so a host it was not allowed is named, not a DNS error", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-service-proxy-")));
  cleanups.push(() => removeTempDir(root));
  const engine = fakeEngine();
  const sandbox = new ShellSandbox({ root: () => root, home: path.join(root, "home"), engine, problem: () => undefined, platform: "linux" });
  useSandbox(sandbox);
  cleanups.push(() => sandbox.close());
  const wrapped = await sandbox.wrap("node server.js", { cwd: root, network: "host" });
  sandbox.finished(wrapped.id);
  expect(engine.wrapped[0]!.prefix).toContain("NODE_USE_ENV_PROXY=1");
});
