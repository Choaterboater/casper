import { afterEach, expect } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BrowserSession } from "../src/browser/session";
import { ServiceManager } from "../src/services/manager";
import { browserTest, executable } from "./support/browser-fixture";
import { removeTempDir } from "./support/temp-dir";

/**
 * A recorded check belongs to the service it ran on, not to the port that service had then. In a real build the
 * AI's server came back on new ports, the old checks replayed against nothing (or the wrong data), and the repair
 * turn put test data into the product's config to make them pass.
 */

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

/** Answers every path with `words`, on $HOST:$PORT as Casper's services do. */
const SERVER = `Bun.serve({ hostname: process.env.HOST ?? "127.0.0.1", port: Number(process.env.PORT), fetch: () => new Response("<!doctype html><h1>" + process.argv[2] + "</h1>", { headers: { "content-type": "text/html; charset=utf-8" } }) });
console.log("listening");
`;

async function setup() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-checks-follow-")));
  cleanup.push(() => removeTempDir(root));
  const project = path.join(root, "project"), state = path.join(root, "state");
  await mkdir(project); await mkdir(state);
  await writeFile(path.join(root, "server.ts"), SERVER);
  const command = (words: string) => `"${process.execPath}" "${path.join(root, "server.ts")}" "${words}"`;
  const services = new ServiceManager({ projectRoot: project, services: {} });
  cleanup.push(() => services.close());
  const session = new BrowserSession({ projectRoot: project, stateDirectory: state, executablePath: executable, services: () => services });
  cleanup.push(() => session.close());
  const signal = new AbortController().signal;
  const scenario = (url: string, expected: string) => ({ name: "Heading", url, steps: [], assertions: [{ kind: "text", selector: "h1", expected }] });
  return { services, session, command, signal, scenario };
}

browserTest("a check recorded on a service replays on that service after it moved to another port", async () => {
  const { services, session, command, signal, scenario } = await setup();
  const app = command("Start page");
  const first = await services.startCommand(app, { ready: { log: "listening" } }, signal);
  const recorded = await session.run({ action: "check", scenario: scenario(`${first.origin}/settings`, "Start page") });
  expect(recorded).toMatchObject({ status: "pass" });
  // Something else takes the old port while it is stopped, so it comes back on another one.
  await services.stop(first.name);
  const squatter = Bun.serve({ hostname: "127.0.0.1", port: Number(new URL(first.origin!).port), fetch: () => new Response("<h1>Someone else</h1>", { headers: { "content-type": "text/html" } }) });
  cleanup.push(() => squatter.stop(true));
  const again = await services.startCommand(app, { ready: { log: "listening" } }, signal);
  expect(again.origin).not.toBe(first.origin);
  session.invalidate();
  const replayed = await session.run({ action: "replay", id: recorded.id });
  expect(replayed).toMatchObject({ status: "pass", freshness: "fresh" });
  expect(replayed.notes).toEqual([`followed ${first.name} to ${again.origin}: it ran at ${first.origin} when this check was recorded`]);
}, 45_000);

browserTest("a check whose server is gone and that fails on Casper's server is stale, not failed; one that already failed stays failed", async () => {
  const { services, session, command, signal, scenario } = await setup();
  const own = await services.startCommand(command("Weather 21°C"), { ready: { log: "listening" } }, signal);
  // Passed on the AI's own server and its test data; failed there too (a real failure).
  const passed = await session.run({ action: "check", scenario: scenario(`${own.origin}/`, "Weather 21°C") });
  const failed = await session.run({ action: "check", scenario: scenario(`${own.origin}/`, "Pi-hole") });
  expect([passed.status, failed.status]).toEqual(["pass", "fail"]);
  // The AI stops its server; Casper's own server for the project holds other data.
  await services.stop(own.name);
  services.ensureSlot("web", { command: command("Dashboard"), port: "auto", ready: { log: "listening" }, timeoutMs: 10_000 });
  await services.start("web", signal);
  session.invalidate();
  await session.replayStale(0);
  const report = await session.report();
  expect(report.checks.find(check => check.id === passed.id)).toMatchObject({ status: "incomplete", freshness: "stale",
    reason: expect.stringContaining(`the server it ran on (${own.origin}) is gone`), gone: own.origin });
  expect(report.checks.find(check => check.id === failed.id)).toMatchObject({ status: "fail", freshness: "fresh" });
  expect(report.status).toBe("fail");
}, 45_000);
