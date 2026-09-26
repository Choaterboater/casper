import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ServiceManager } from "../src/services/manager";
import { SmokeChecks, type SmokeCheck } from "../src/services/smoke";
import { serviceTool } from "../src/services/tool";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** A notes server that honors PORT/HOST; the unsolved one has no POST /notes. */
export function notesServer(solved: boolean): string {
  return `const notes = [];
Bun.serve({ hostname: process.env.HOST, port: Number(process.env.PORT), async fetch(request) {
  const { pathname } = new URL(request.url);
  if (pathname === "/health") return new Response("ok");
  if (pathname === "/notes" && request.method === "GET") return Response.json(notes);
  ${solved ? `if (pathname === "/notes" && request.method === "POST") { const note = { id: notes.length + 1, ...(await request.json()) }; notes.push(note); return Response.json(note, { status: 201 }); }` : ""}
  return new Response("not found", { status: 404 });
} });
console.log("listening");
`;
}

async function fixture(options: { command?: string } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-smoke-run-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src/server.ts"), notesServer(false));
  const manager = new ServiceManager({ projectRoot: root, services: {
    api: { command: options.command ?? `"${process.execPath}" src/server.ts`, port: "auto", ready: { http: "/health" }, timeoutMs: 10_000, scope: { inputs: ["src"] } },
  } });
  cleanups.push(() => manager.close().catch(() => {}));
  return { root, manager };
}

const list: SmokeCheck = { name: "list notes", service: "api", request: { method: "GET", path: "/notes" }, expect: { status: 200, json: [] } };
const create = { name: "create note", service: "api", request: { method: "POST", path: "/notes", body: { title: "a" } }, expect: { status: 201, json: { title: "a" } } };
const signal = () => new AbortController().signal;

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
