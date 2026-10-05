import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hostProcessPlatform, ProcessCleanupError, type ProcessPlatform, type ProcessRecord } from "../src/platform/processes";
import { ServiceManager } from "../src/services/manager";
import { SmokeChecks, type SmokeCheck } from "../src/services/smoke";
import { serviceTool } from "../src/services/tool";
import { formatReceipt, formatTaskResult } from "../src/task/result";
import { CRASH_EXIT, crashService, notesServer } from "./support/notes-server";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(options: { command?: string; platform?: ProcessPlatform } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-smoke-run-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src/server.ts"), notesServer(false));
  const manager = new ServiceManager({ projectRoot: root, platform: options.platform, services: {
    api: { command: options.command ?? `"${process.execPath}" src/server.ts`, port: "auto", ready: { http: "/health" }, timeoutMs: 10_000, scope: { inputs: ["src"] } },
  } });
  cleanups.push(() => manager.close().catch(() => {}));
  return { root, manager };
}

const list: SmokeCheck = { name: "list notes", service: "api", request: { method: "GET", path: "/notes" }, expect: { status: 200, json: [] } };
const create = { name: "create note", service: "api", request: { method: "POST", path: "/notes", body: { title: "a" } }, expect: { status: 201, json: { title: "a" } } };
const signal = () => new AbortController().signal;
const killedLine = `api restarted after crash (${CRASH_EXIT.signal ? `signal ${CRASH_EXIT.signal}` : `exit ${CRASH_EXIT.code}`})`;

test("a model check records a failing baseline on the unsolved server and replays to a pass after the fix restarts it", async () => {
  const f = await fixture();
  const smoke = new SmokeChecks([], () => f.manager);
  const tool = serviceTool(() => f.manager, undefined, () => smoke);
  const call = async (args: Record<string, unknown>) => {
    const result = await tool.execute(args, signal());
    return { isError: result.isError === true, data: JSON.parse(result.text).data };
  };
  const recorded = await call({ action: "check", ...create });
  expect(recorded.isError).toBe(false);
  expect(recorded.data.check).toMatchObject({ id: "smoke-1", name: "create note", source: "model", baseline: "fail", status: "fail",
    actual: { status: 404, body: "not found" }, reason: "status 404, expected 201" });
  expect(recorded.data.guidance).toContain("failed before the change and passes after it");
  await writeFile(path.join(f.root, "src/server.ts"), notesServer(true));
  f.manager.markEdited(path.join(f.root, "src/server.ts"));
  const replayed = await call({ action: "replay", id: "smoke-1" });
  expect(replayed.data.check).toMatchObject({ id: "smoke-1", baseline: "fail", status: "pass", restarted: true, actual: { status: 201 } });
  expect((await call({ action: "replay", id: "smoke-9" })).isError).toBe(true);
  expect((await call({ action: "check", ...create, service: "web" })).isError).toBe(true);
  expect(tool.description).toContain("record a check before editing");
}, 30_000);

test("the run reports configured and model checks with their evidence: a baseline pass is only an observation", async () => {
  const f = await fixture();
  const smoke = new SmokeChecks([list], () => f.manager);
  expect(smoke.size).toBe(1);
  await smoke.record(create, signal());
  await smoke.record({ ...list, name: "lists before too" }, signal());
  let report = await smoke.run(signal());
  expect(report.status).toBe("fail");
  expect(report.checks.map(({ name, source, baseline, status, evidence }) => ({ name, source, baseline, status, evidence }))).toEqual([
    { name: "list notes", source: "config", baseline: undefined, status: "pass", evidence: true },
    { name: "create note", source: "model", baseline: "fail", status: "fail", evidence: false },
    { name: "lists before too", source: "model", baseline: "pass", status: "pass", evidence: false },
  ]);
  await writeFile(path.join(f.root, "src/server.ts"), notesServer(true));
  f.manager.markEdited("src/server.ts");
  report = await smoke.run(signal());
  expect(report.status).toBe("pass");
  expect(report.checks.map(check => check.evidence)).toEqual([true, true, false]);
}, 30_000);

test("a service that will not start makes its checks incomplete, with the reason", async () => {
  const f = await fixture({ command: `"${process.execPath}" -e "process.exit(4)"` });
  const report = await new SmokeChecks([list], () => f.manager).run(signal());
  expect(report.status).toBe("incomplete");
  expect(report.checks[0]).toMatchObject({ status: "incomplete", evidence: false, reason: expect.stringContaining("Service api did not start") });
}, 30_000);

test("a baseline without an HTTP response (a transport error) is not a failing baseline, so a later pass is no evidence", async () => {
  const f = await fixture();
  // Ready on /health, but every other request has its connection destroyed without a response.
  await writeFile(path.join(f.root, "src/server.ts"), `require("node:http").createServer((request, response) => {
  if (request.url === "/health") response.end("ok"); else request.socket.destroy();
}).listen(Number(process.env.PORT), process.env.HOST);\n`);
  const smoke = new SmokeChecks([], () => f.manager);
  const recorded = await smoke.record(create, signal());
  expect(recorded).toMatchObject({ baseline: "incomplete", status: "fail", reason: expect.stringContaining("request failed") });
  expect(recorded.actual).toBeUndefined();
  await writeFile(path.join(f.root, "src/server.ts"), notesServer(true));
  f.manager.markEdited("src/server.ts");
  expect((await smoke.run(signal())).checks[0]).toMatchObject({ baseline: "incomplete", status: "pass", evidence: false });
}, 30_000);

test("unknown cleanup of another service makes smoke incomplete even when the checked service is fresh and passes", async () => {
  // The OS listing keeps showing the ad-hoc service's root after it is gone, so its stop is never confirmed.
  // The first record seen stays, even if Windows hands the PID to a new process meanwhile (it does that quickly).
  let stuck = 0, kept: ProcessRecord | undefined;
  const host = hostProcessPlatform();
  const platform: ProcessPlatform = { ...host, list: async () => {
    const all = await host.list();
    if (stuck) { kept ??= all.get(stuck); if (kept) all.set(stuck, kept); }
    return all;
  } };
  const f = await fixture({ platform });
  await f.manager.start("api", signal());
  const adhoc = await f.manager.startCommand(`"${process.execPath}" src/server.ts`, { ready: { http: "/health" } }, signal());
  stuck = adhoc.pid!;
  await expect(f.manager.stop(adhoc.name)).rejects.toBeInstanceOf(ProcessCleanupError);
  const report = await new SmokeChecks([list], () => f.manager).run(signal());
  expect(report.checks[0]).toMatchObject({ status: "pass", evidence: true });
  // Not toMatchObject with an asymmetric matcher: Bun 1.4 writes the matcher into the received object.
  expect(report.status).toBe("incomplete");
  expect(report.reason).toContain("could not confirm");
  expect(formatReceipt({ execution: "completed", verification: { status: "incomplete", results: [], rounds: [], repairAttempts: 0, smoke: report } }))
    .toContain("smoke 1/1 passed; Casper could not confirm a service's processes were stopped");
}, 30_000);

test("a crash since the last report is surfaced on the smoke run, once, and the verbose receipt says the service restarted after it", async () => {
  const f = await fixture();
  const started = await f.manager.start("api", signal());
  await crashService(started.pid!);
  while (f.manager.status()[0]!.state !== "crashed") await Bun.sleep(20);
  const report = await new SmokeChecks([list], () => f.manager).run(signal());
  expect(report.checks[0]).toMatchObject({ status: "pass", restarted: true });
  expect(report.crashes).toEqual([{ service: "api", exit: CRASH_EXIT, tail: expect.any(String) }]);
  expect(f.manager.takeCrashes()).toEqual([]);
  expect(formatTaskResult({ execution: "completed", verification: { status: "pass", results: [], rounds: [], repairAttempts: 0, smoke: report } }))
    .toContain(killedLine);
  expect(formatReceipt({ execution: "completed", verification: { status: "pass", results: [], rounds: [], repairAttempts: 0, smoke: report } }))
    .toContain(killedLine);
}, 30_000);
