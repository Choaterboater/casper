import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BrowserSession } from "../src/browser/session";
import { browserTool } from "../src/browser/tools";
import { needsSymlinks, posixModes } from "./support/platform";

const executable = process.env.CASPER_BROWSER_EXECUTABLE ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browserTest = existsSync(executable) ? test : test.skip;
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(options: { executablePath?: string; confirm?: (request: unknown, signal: AbortSignal) => Promise<boolean> } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-browser-test-")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project"), state = path.join(root, "state");
  await mkdir(project); await mkdir(state);
  const sourceFile = path.join(project, "index.html");
  await writeFile(sourceFile, '<!doctype html><title>Browser fixture</title><h1>Hello Casper</h1><button>Save</button><script>console.error("synthetic-console-error");fetch("/missing-api")</script>');
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(request) {
    if (new URL(request.url).pathname === "/hang") return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("<html>")); } }), { headers: { "content-type": "text/html" } });
    if (new URL(request.url).pathname === "/missing-api") return new Response("fixture failure", { status: 503 });
    return new Response(await readFile(sourceFile), { headers: { "content-type": "text/html", "cache-control": "no-store" } });
  } });
  cleanup.push(async () => { server.stop(true); });
  const session = new BrowserSession({ projectRoot: project, stateDirectory: state, executablePath: executable, ...options });
  cleanup.push(() => session.close());
  return { root, project, sourceFile, state, session, url: `http://127.0.0.1:${server.port}` };
}

test("invalid URLs, unknown fields and oversized scenarios fail before launching a browser", async () => {
  const f = await fixture();
  for (const input of [
    { action: "open", url: "file:///etc/passwd" }, { action: "open", url: "http://user:pass@localhost" },
    { action: "open", url: f.url, executablePath: "/bin/sh" }, { action: "evaluate", source: "1+1" },
    { action: "check", scenario: { name: "x".repeat(17000) } },
  ]) await expect(f.session.run(input)).rejects.toThrow();
  expect(f.session.status().state).toBe("idle");
  expect(await readdir(f.state)).toEqual([]);
});

needsSymlinks("an unavailable executable is an explicit error, never an automatic install or passing check", async () => {
  const f = await fixture({ executablePath: "/nonexistent/casper-browser-fixture" });
  await expect(f.session.run({ action: "open", url: f.url })).rejects.toThrow();
  expect((await f.session.report()).status).toBe("incomplete");
  await f.session.close();
  expect(await readdir(f.state)).toEqual([]);
});

browserTest("a hanging navigation times out and the same session can recover", async () => {
  const f = await fixture();
  const started = performance.now();
  await expect(f.session.run({ action: "open", url: `${f.url}/hang` })).rejects.toThrow("timeout");
  expect(performance.now() - started).toBeLessThan(15_000);
  await f.session.run({ action: "open", url: f.url });
  expect(await f.session.run({ action: "inspect" })).toMatchObject({ title: "Browser fixture" });
}, 20_000);

browserTest("visibility and rectangle overlap replay separately from input freshness", async () => {
  const f = await fixture();
  const html = (left: number) => `<style>div{position:absolute;width:50px;height:50px;top:0}#a{left:0}#b{left:${left}px}</style><div id="a">A</div><div id="b">B</div>`;
  await writeFile(f.sourceFile, html(20));
  const baseline = await f.session.run({ action: "check", scenario: { name: "Overlapping cards", url: f.url, steps: [],
    assertions: [{ kind: "visible", selector: "#a" }, { kind: "no-overlap", selector: "#a", other: "#b" }] } });
  expect(baseline).toMatchObject({ status: "fail", assertions: [{ status: "pass" }, { status: "fail" }] });
  await writeFile(f.sourceFile, html(100));
  expect(await f.session.run({ action: "replay", id: baseline.id })).toMatchObject({ status: "pass", freshness: "unavailable", baseline: "fail" });
  expect((await f.session.report()).status).toBe("incomplete");
}, 20_000);

browserTest("tool observations remain within the byte budget after terminal-control escaping", async () => {
  const f = await fixture();
  await writeFile(f.sourceFile, `<meta charset="utf-8"><main>${"\u007f".repeat(10000)}</main>`);
  await f.session.run({ action: "open", url: f.url });
  const result = await browserTool(f.session).execute({ action: "inspect" });
  expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(16_384);
  expect(JSON.parse(result.text).truncated).toBe(true);
}, 20_000);

browserTest("fill replaces an entire multiline textarea rather than only the clicked paragraph", async () => {
  const f = await fixture();
  await writeFile(f.sourceFile, '<textarea id="note" oninput="document.querySelector(\'#out\').textContent=this.value">First line\nSecond line</textarea><p id="out"></p>');
  const result = await f.session.run({ action: "check", scenario: { name: "Replace text", url: f.url, scope: { inputs: ["index.html"] },
    steps: [{ action: "fill", selector: "#note", value: "Replacement", impact: "local-test", reason: "Synthetic textarea" }],
    assertions: [{ kind: "text", selector: "#out", expected: "Replacement" }] } });
  expect(result.status).toBe("pass");
}, 20_000);

browserTest("a browser crash invalidates earlier passing evidence and cannot resurrect the dead session", async () => {
  const f = await fixture();
  const result = await f.session.run({ action: "check", scenario: { name: "Heading", url: f.url, scope: { inputs: ["index.html"] }, steps: [], assertions: [{ kind: "text", selector: "h1", expected: "Hello Casper" }] } });
  expect(result.status).toBe("pass");
  const pid = f.session.status().ownedBrowserPid!;
  process.kill(pid, "SIGKILL");
  for (let i = 0; i < 40 && f.session.status().state !== "closed"; i++) await new Promise(resolve => setTimeout(resolve, 25));
  expect(f.session.status().state).toBe("closed");
  await expect(f.session.run({ action: "inspect" })).rejects.toThrow("closed");
  expect(await f.session.report()).toMatchObject({ status: "incomplete", checks: [{ freshness: "stale" }] });
}, 20_000);

browserTest("known consequential labels cannot bypass approval by claiming local-test", async () => {
  let approved = false, approvals = 0, effects = 0;
  const f = await fixture({ confirm: async () => { approvals++; return approved; } });
  const endpoint = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { effects++; return new Response("ok", { headers: { "access-control-allow-origin": "*" } }); } });
  cleanup.push(async () => { endpoint.stop(true); });
  await writeFile(f.sourceFile, `<button id="send" onclick="fetch('http://127.0.0.1:${endpoint.port}/effect')">Send message</button>`);
  await f.session.run({ action: "open", url: f.url });
  const click = { action: "click", selector: "#send", impact: "local-test", reason: "Synthetic local fixture" };
  await expect(f.session.run(click)).rejects.toThrow("approval");
  expect(effects).toBe(0); expect(approvals).toBe(1);
  approved = true; await f.session.run(click);
  for (let i = 0; i < 20 && effects === 0; i++) await new Promise(resolve => setTimeout(resolve, 20));
  expect(effects).toBe(1); expect(approvals).toBe(2);
}, 20_000);

browserTest("screenshot writes refuse redirected artifact directories", async () => {
  const f = await fixture();
  const outside = path.join(f.root, "outside"); await mkdir(outside);
  await symlink(outside, path.join(f.state, "browser"), "dir");
  await f.session.run({ action: "open", url: f.url });
  await expect(f.session.run({ action: "screenshot" })).rejects.toThrow();
  expect(await readdir(outside)).toEqual([]);
}, 20_000);

browserTest("cancellation closes an in-flight browser and its owned process without stopping the source server", async () => {
  const f = await fixture();
  await f.session.run({ action: "open", url: f.url });
  const pid = f.session.status().ownedBrowserPid;
  expect(typeof pid).toBe("number");
  expect(() => process.kill(pid!, 0)).not.toThrow();
  const controller = new AbortController();
  const work = f.session.run({ action: "open", url: `${f.url}/hang` }, controller.signal);
  await new Promise(resolve => setTimeout(resolve, 100));
  await expect(f.session.run({ action: "inspect" })).rejects.toThrow("busy");
  controller.abort();
  await expect(work).rejects.toThrow();
  await f.session.close();
  expect(f.session.status().state).toBe("closed");
  expect(() => process.kill(pid!, 0)).toThrow();
  expect((await fetch(f.url)).status).toBe(200);
}, 20_000);

test("a task-owned development script is stopped without touching an existing local server", async () => {
  const f = await fixture();
  // Reserve then release an ephemeral port for the managed fixture.
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("probe") });
  const port = probe.port; await probe.stop(true);
  await writeFile(path.join(f.project, "dev.ts"), 'Bun.serve({hostname:"127.0.0.1",port:Number(process.env.PORT),fetch:()=>new Response("managed fixture")});');
  await writeFile(path.join(f.project, "package.json"), JSON.stringify({ scripts: { dev: `${process.execPath} dev.ts` } }));
  await expect(f.session.run({ action: "serve", script: "dev", url: f.url, impact: "local-test", reason: "Synthetic project" })).rejects.toThrow("already in use");
  const url = `http://127.0.0.1:${port}`;
  const started = await f.session.run({ action: "serve", script: "dev", url, impact: "local-test", reason: "Synthetic project" });
  expect(started).toMatchObject({ ready: true });
  expect(await (await fetch(url)).text()).toBe("managed fixture");
  await f.session.close();
  await expect(fetch(url)).rejects.toThrow();
  expect((await fetch(f.url)).status).toBe(200);
}, 15_000);

browserTest("an immutable reproduction detects behavior and layout failures, replays after a fix and goes stale after later edits", async () => {
  const f = await fixture();
  const html = (fixed: boolean) => `<!doctype html><meta name="viewport" content="width=device-width"><style>main{width:${fixed ? "100%" : "900px"}}</style><main><input id="name"><button id="save">Save</button><p id="status">Not saved</p></main><script>document.querySelector('#save').onclick=()=>document.querySelector('#status').textContent=${fixed ? "'Saved '+document.querySelector('#name').value" : "'Broken'"}</script>`;
  await writeFile(f.sourceFile, html(false));
  const baseline = await f.session.run({ action: "check", scenario: { name: "Save at mobile width", url: f.url, viewport: { width: 375, height: 700 },
    scope: { inputs: ["index.html"] }, steps: [
      { action: "fill", selector: "#name", value: "Ada", impact: "local-test", reason: "Synthetic name" },
      { action: "click", selector: "#save", impact: "local-test", reason: "Synthetic save" },
    ], assertions: [{ kind: "text", selector: "#status", expected: "Saved Ada" }, { kind: "no-horizontal-overflow" }] } });
  expect(baseline).toMatchObject({ status: "fail", baseline: "fail", freshness: "fresh", assertions: [{ status: "fail" }, { status: "fail" }] });
  await writeFile(f.sourceFile, html(true));
  const replay = await f.session.run({ action: "replay", id: baseline.id });
  expect(replay).toMatchObject({ id: baseline.id, scenarioSha256: baseline.scenarioSha256, status: "pass", baseline: "fail", freshness: "fresh", assertions: [{ status: "pass" }, { status: "pass" }] });
  await writeFile(f.sourceFile, html(false));
  expect(await f.session.report()).toMatchObject({ status: "incomplete", checks: [{ freshness: "stale" }] });
  await expect(f.session.run({ action: "replay", id: baseline.id, scenario: {} })).rejects.toThrow("Unexpected");
}, 25_000);

browserTest("local synthetic interactions proceed while consequential actions require approval", async () => {
  const approvals: unknown[] = [];
  const f = await fixture({ confirm: async request => { approvals.push(request); return false; } });
  await f.session.run({ action: "open", url: f.url });
  await f.session.run({ action: "click", selector: "button", impact: "local-test", reason: "Synthetic fixture button" });
  expect(approvals).toEqual([]);
  await expect(f.session.run({ action: "click", selector: "button", impact: "consequential", reason: "Send a real message" })).rejects.toThrow("approval");
  expect(approvals).toHaveLength(1);
  await expect(f.session.run({ action: "click", selector: "button" })).rejects.toThrow("impact");
}, 20_000);

browserTest("a disposable browser inspects a local page and saves a real screenshot without changing the project", async () => {
  const f = await fixture();
  expect(f.session.status().state).toBe("idle");
  await f.session.run({ action: "open", url: f.url });
  const observed = await f.session.run({ action: "inspect" });
  expect(observed).toMatchObject({ title: "Browser fixture", text: expect.stringContaining("Hello Casper") });
  const screenshot = await f.session.run({ action: "screenshot" });
  expect(typeof screenshot.path).toBe("string");
  const bytes = await readFile(String(screenshot.path));
  expect(bytes.subarray(1, 4).toString()).toBe("PNG");
  expect(String(screenshot.path).startsWith(f.state + path.sep)).toBe(true);
  expect(bytes.readUInt32BE(16)).toBe(1280);
  // Mode bits are a POSIX guarantee; Windows synthesizes them (tests/support/platform.ts).
  if (posixModes) {
    expect((await stat(String(screenshot.path))).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(String(screenshot.path)))).mode & 0o777).toBe(0o700);
  }
  await f.session.close();
  expect(f.session.status().state).toBe("closed");
  await expect(f.session.run({ action: "inspect" })).rejects.toThrow("closed");
}, 20_000);
