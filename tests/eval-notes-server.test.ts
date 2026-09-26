import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfiguration } from "../src/config/load";
import { ServiceManager } from "../src/services/manager";
import { SmokeChecks } from "../src/services/smoke";
import { prepareWorkdir, referenceChanges } from "../evals/runner";
import { findEvalTask } from "../evals/tasks";

const repoRoot = path.resolve(import.meta.dir, "..");
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Both harnesses see the fixture's server; Casper also reads its `services.api` and `GET /notes` smoke check. */
test.each(["solved fixture", "core-rest-validation start"])("the notes fixture server becomes ready and answers GET /notes (%s)", async (which) => {
  const task = findEvalTask("core-rest-validation")!;
  const workdir = await prepareWorkdir(which === "solved fixture" ? { ...task, setup: undefined } : task, repoRoot);
  cleanup.push(() => rm(workdir, { recursive: true, force: true }));
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-notes-server-home-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const config = await loadConfiguration({ projectRoot: workdir, homeDir: home });
  expect(config.warnings ?? []).toEqual([]);
  expect(config.services.api).toMatchObject({ port: "auto", ready: { http: "/notes" } });
  // No configured check for the endpoint the task adds: that would be a spec only Casper sees.
  expect(config.smoke.map((check) => `${check.request.method} ${check.request.path}`)).toEqual(["GET /notes"]);
  expect(JSON.parse(await readFile(path.join(workdir, "package.json"), "utf8")).scripts.dev).toBeString();

  const manager = new ServiceManager({ projectRoot: workdir, services: config.services });
  cleanup.push(() => manager.close().catch(() => {}));
  const started = await manager.start("api", new AbortController().signal);
  expect(started.state).toBe("ready");
  const origin = manager.origin("api")!;
  expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  const response = await fetch(`${origin}/notes`);
  expect({ status: response.status, body: await response.json() }).toEqual({ status: 200, body: { notes: [] } });
  const report = await new SmokeChecks(config.smoke, () => manager).run(new AbortController().signal);
  expect({ status: report.status, checks: report.checks.map(({ source, status, evidence }) => ({ source, status, evidence })) })
    .toEqual({ status: "pass", checks: [{ source: "config", status: "pass", evidence: true }] });
  await manager.close();
  expect(alive(started.pid!)).toBe(false);
}, 30_000);

test("the fixture server is fixture code the validation task's setup leaves alone", async () => {
  const task = findEvalTask("core-rest-validation")!;
  const changes = await referenceChanges(task, repoRoot);
  const touched = [...changes.added, ...changes.modified, ...changes.removed];
  expect(touched.filter((entry) => entry === "src/server.ts" || entry === "package.json" || entry.startsWith(".casper/"))).toEqual([]);
});
