import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BrowserSession } from "../src/browser/session";
import type { DetectedWebService } from "../src/services/detect";
import { ServiceManager } from "../src/services/manager";
import { PageChecks, type PageOpener } from "../src/services/page-checks";
import { removeTempDir } from "./support/temp-dir";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** An app that allows one copy per project: a second copy exits 1 while the first one's process is alive. */
const SERVER = `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
if (existsSync("server.lock")) {
  const pid = Number(readFileSync("server.lock", "utf8"));
  try { process.kill(pid, 0); console.error("Live owner detected."); process.exit(1); } catch {}
}
writeFileSync("server.lock", String(process.pid));
Bun.serve({ hostname: process.env.HOST, port: Number(process.env.PORT), fetch: () => new Response("<html>ok</html>", { headers: { "content-type": "text/html" } }) });
`;

const opener: PageOpener = { consoleChecked: true, async close() {},
  async load(url, signal) {
    const response = await fetch(url, { signal }); await response.text();
    return { status: response.status, consoleChecked: true, consoleErrors: [], pageErrors: [], failedRequests: [] };
  } };

test("an app that allows one copy, started by browser serve, is the server the page checks open pages on", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-one-copy-")));
  cleanups.push(() => removeTempDir(root));
  const command = `"${process.execPath}" server.ts`;
  await writeFile(path.join(root, "server.ts"), SERVER);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { start: command } }));
  const manager = new ServiceManager({ projectRoot: root, services: {} });
  cleanups.push(() => manager.close().catch(() => {}));
  const session = new BrowserSession({ projectRoot: root, stateDirectory: path.join(root, ".state"), allowActions: () => true, services: () => manager });
  cleanups.push(() => session.close().catch(() => {}));
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const url = `http://127.0.0.1:${probe.port}/`; await probe.stop(true);
  expect(await session.run({ action: "serve", script: "start", url, impact: "local-test", reason: "Look at the app" })).toMatchObject({ ready: true });

  // The page check's slot is the one serve started: no second copy is started beside it, so the app's lock never refuses.
  const service: DetectedWebService = { name: "web", source: "package.json", label: "npm run start", frameworks: [], portFlags: false,
    spec: { command, port: "auto", ready: { http: "/" }, timeoutMs: 10_000 } };
  const report = await new PageChecks(() => manager, service, opener, { open: ["/"], skipped: [] }).run(new AbortController().signal);
  expect(report.reason).toBeUndefined();
  expect(report.status).toBe("pass");
  expect(report.server.origin).toBe(url.slice(0, -1));
  expect(report.pages.map(page => page.path)).toEqual(["/"]);

  // The one server keeps running for the next browser action, and only one slot holds it.
  expect((await fetch(url)).status).toBe(200);
  expect(manager.status()).toMatchObject([{ name: "web", state: "ready" }]);
}, 40_000);
