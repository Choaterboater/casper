import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, realpath, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { actionHold, BrowserSession, choiceLinks, serveHolds } from "../src/browser/session";
import { browserTool } from "../src/browser/tools";
import { browserFixtures, browserTest, executable, freePort } from "./support/browser-fixture";
import { needsSymlinks, posixModes } from "./support/platform";
import { removeTempDir } from "./support/temp-dir";

const { cleanup, fixture } = browserFixtures();

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
  const f = await fixture({ navigationTimeoutMs: 1_000 });
  const started = performance.now();
  await expect(f.session.run({ action: "open", url: `${f.url}/hang` })).rejects.toThrow("Navigation timeout of 1000 ms exceeded");
  // The injected navigation deadline is 1 s; the rest is Chromium startup, which a loaded host stretches.
  expect(performance.now() - started).toBeLessThan(30_000);
  await f.session.run({ action: "open", url: f.url });
  expect(await f.session.run({ action: "inspect" })).toMatchObject({ title: "Browser fixture" });
}, 45_000);

browserTest("visibility and rectangle overlap replay separately from input freshness", async () => {
  const f = await fixture();
  const html = (left: number) => `<style>div{position:absolute;width:50px;height:50px;top:0}#a{left:0}#b{left:${left}px}</style><div id="a">A</div><div id="b">B</div>`;
  await writeFile(f.sourceFile, html(20));
  const baseline = await f.session.run({ action: "check", scenario: { name: "Overlapping cards", url: f.url, steps: [],
    assertions: [{ kind: "visible", selector: "#a" }, { kind: "no-overlap", selector: "#a", other: "#b" }] } });
  expect(baseline).toMatchObject({ status: "fail", assertions: [{ status: "pass" }, { status: "fail" }] });
  await writeFile(f.sourceFile, html(100));
  expect(await f.session.run({ action: "replay", id: baseline.id })).toMatchObject({ status: "pass", freshness: "fresh", baseline: "fail" });
  expect((await f.session.report()).status).toBe("pass");
}, 20_000);

browserTest("a check that names no scope watches the project folder, leaving out dependency and build folders", async () => {
  const f = await fixture();
  await mkdir(path.join(f.project, "node_modules"));
  const result = await f.session.run({ action: "check", scenario: { name: "Heading", url: f.url, steps: [], assertions: [{ kind: "text", selector: "h1", expected: "Hello Casper" }] } });
  expect(result).toMatchObject({ status: "pass", freshness: "fresh" });
  // Another program's write inside node_modules is not one of the page's inputs.
  await writeFile(path.join(f.project, "node_modules", "cache.json"), "{}");
  expect(await f.session.report()).toMatchObject({ status: "pass", checks: [{ freshness: "fresh" }] });
  // A write Casper's tools did not make, to a project file, still makes the pass stale.
  await writeFile(path.join(f.project, "style.css"), "h1{color:red}");
  expect(await f.session.report()).toMatchObject({ status: "incomplete", checks: [{ freshness: "stale" }] });
}, 20_000);

browserTest("a project too big to watch whole says to name the files the page depends on", async () => {
  const f = await fixture();
  await mkdir(path.join(f.project, "big"));
  await Promise.all(Array.from({ length: 4200 }, (_, i) => writeFile(path.join(f.project, "big", `${i}.txt`), "")));
  const result = await f.session.run({ action: "check", scenario: { name: "Heading", url: f.url, steps: [], assertions: [{ kind: "text", selector: "h1", expected: "Hello Casper" }] } });
  expect(result).toMatchObject({ status: "pass", freshness: "unavailable" });
  expect(String(result.reason)).toContain("scope.inputs");
}, 30_000);

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

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function crash(session: BrowserSession) {
  const pid = session.status().ownedBrowserPid!;
  process.kill(pid, "SIGKILL");
  for (let i = 0; i < 200 && (session.status().ownedBrowserPid === pid || alive(pid)); i++) await new Promise(resolve => setTimeout(resolve, 25));
  return pid;
}

browserTest("a browser crash makes earlier passing evidence stale and the next open starts a fresh Chrome", async () => {
  const f = await fixture();
  const result = await f.session.run({ action: "check", scenario: { name: "Heading", url: f.url, scope: { inputs: ["index.html"] }, steps: [], assertions: [{ kind: "text", selector: "h1", expected: "Hello Casper" }] } });
  expect(result.status).toBe("pass");
  const first = await crash(f.session);
  expect(f.session.status().state).toBe("idle");
  expect(await f.session.report()).toMatchObject({ status: "incomplete", checks: [{ freshness: "stale" }] });
  // The old page is gone, said plainly; opening again starts a new Chrome and says what happened once.
  await expect(f.session.run({ action: "inspect" })).rejects.toThrow("Chrome stopped unexpectedly");
  const reopened = await f.session.run({ action: "open", url: f.url });
  expect(reopened.title).toBe("Browser fixture");
  expect(f.session.status().ownedBrowserPid).not.toBe(first);
  expect(reopened).not.toHaveProperty("restarted");
}, 30_000);

browserTest("a crash right before an action is named in that action's result", async () => {
  const f = await fixture();
  await f.session.run({ action: "open", url: f.url });
  await crash(f.session);
  expect(await f.session.run({ action: "open", url: f.url })).toMatchObject({ title: "Browser fixture", restarted: expect.stringContaining("started a new one") });
}, 30_000);

browserTest("after two fresh starts a third crash closes the session for good", async () => {
  const f = await fixture();
  for (let i = 0; i < 2; i++) { await f.session.run({ action: "open", url: f.url }); await crash(f.session); }
  await f.session.run({ action: "open", url: f.url });
  const pid = f.session.status().ownedBrowserPid!;
  process.kill(pid, "SIGKILL");
  for (let i = 0; i < 200 && f.session.status().state !== "closed"; i++) await new Promise(resolve => setTimeout(resolve, 25));
  expect(f.session.status().state).toBe("closed");
  await expect(f.session.run({ action: "open", url: f.url })).rejects.toThrow("closed");
}, 45_000);

// A Chrome that never answers on its first start (seen on fresh Windows runners) is replaced by one fresh start.
(process.platform === "win32" ? test.skip : browserTest)("a first Chrome start that never answers is replaced by one fresh start", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-slow-chrome-")));
  cleanup.push(() => removeTempDir(root));
  const starts = path.join(root, "starts"), wrapper = path.join(root, "chrome");
  await writeFile(wrapper, `#!/bin/sh\necho start >> "${starts}"\nif [ "$(wc -l < "${starts}")" -le 1 ]; then exec sleep 60; fi\nexec "${executable}" "$@"\n`, { mode: 0o755 });
  const f = await fixture({ executablePath: wrapper, firstStartMs: 1_000 });
  expect(await f.session.run({ action: "open", url: f.url })).toMatchObject({ title: "Browser fixture" });
  expect((await readFile(starts, "utf8")).trim().split("\n")).toHaveLength(2);
}, 30_000);

// The fresh start after one that never answered is still part of the cold start: it doesn't use up the open's time either.
(process.platform === "win32" ? test.skip : browserTest)("a fresh Chrome start after one that never answered doesn't use up the open's time", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-slow-chrome-")));
  cleanup.push(() => removeTempDir(root));
  const starts = path.join(root, "starts"), wrapper = path.join(root, "chrome");
  await writeFile(wrapper, `#!/bin/sh\necho start >> "${starts}"\nif [ "$(wc -l < "${starts}")" -le 1 ]; then exec sleep 60; fi\nsleep 2\nexec "${executable}" "$@"\n`, { mode: 0o755 });
  const f = await fixture({ executablePath: wrapper, firstStartMs: 1_000, actionTimeoutMs: 1_500 });
  expect(await f.session.run({ action: "open", url: f.url })).toMatchObject({ title: "Browser fixture" });
  expect((await readFile(starts, "utf8")).trim().split("\n")).toHaveLength(2);
}, 30_000);

// The fresh start's Chrome came up but its page didn't: that Chrome was left running, unowned, on the profile the
// next start then reused.
(process.platform === "win32" ? test.skip : browserTest)("a fresh start whose page fails stops its Chrome, and the next open starts clean", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-failed-retry-")));
  cleanup.push(() => removeTempDir(root));
  const starts = path.join(root, "starts"), pids = path.join(root, "pids"), wrapper = path.join(root, "chrome");
  await writeFile(wrapper, `#!/bin/sh\necho start >> "${starts}"\nif [ "$(wc -l < "${starts}")" -le 1 ]; then exec sleep 60; fi\necho $$ >> "${pids}"\nexec "${executable}" "$@"\n`, { mode: 0o755 });
  // A long action limit: a loaded machine can take most of 15 s to start the second Chrome.
  const f = await fixture({ executablePath: wrapper, firstStartMs: 1_000, actionTimeoutMs: 40_000 });
  const session = f.session as unknown as { newPage(): Promise<unknown> };
  const newPage = session.newPage;
  session.newPage = async () => { session.newPage = newPage; throw new Error("synthetic page failure"); };
  await expect(f.session.run({ action: "open", url: f.url })).rejects.toThrow("synthetic page failure");
  expect(f.session.status()).toMatchObject({ state: "idle", ownedBrowserPid: undefined });
  const [failed] = (await readFile(pids, "utf8")).trim().split("\n").map(Number);
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let i = 0; i < 200 && alive(failed!); i++) await new Promise(resolve => setTimeout(resolve, 25));
  expect(alive(failed!)).toBe(false);
  expect(await f.session.run({ action: "open", url: f.url })).toMatchObject({ title: "Browser fixture" });
}, 90_000);

// On a busy machine a cold Chrome start took most of an open's 15 s, and the open ended in a bare AbortError.
(process.platform === "win32" ? test.skip : browserTest)("a slow Chrome start doesn't use up the open's time, and an open that runs out says so", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-slow-start-")));
  cleanup.push(() => removeTempDir(root));
  const wrapper = path.join(root, "chrome");
  await writeFile(wrapper, `#!/bin/sh\nsleep 2\nexec "${executable}" "$@"\n`, { mode: 0o755 });
  const f = await fixture({ executablePath: wrapper, firstStartMs: 20_000, actionTimeoutMs: 1_500 });
  expect(await f.session.run({ action: "open", url: f.url })).toMatchObject({ title: "Browser fixture" });
  // A page that never finishes loading, with Chrome already up: the open's own time runs out.
  await expect(f.session.run({ action: "open", url: new URL("/hang", f.url).href })).rejects.toThrow("The browser's open ran out of time (2 s) and Casper closed the browser; open the page again.");
}, 30_000);

browserTest("known consequential labels cannot bypass approval by claiming local-test", async () => {
  let approved = false, approvals = 0, effects = 0;
  const f = await fixture({ confirm: async () => { approvals++; return approved; } });
  const endpoint = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { effects++; return new Response("ok", { headers: { "access-control-allow-origin": "*" } }); } });
  cleanup.push(async () => { endpoint.stop(true); });
  await writeFile(f.sourceFile, `<button id="send" onclick="fetch('http://127.0.0.1:${endpoint.port}/effect')">Send message</button>`);
  await f.session.run({ action: "open", url: f.url });
  const click = { action: "click", selector: "#send", impact: "local-test", reason: "Synthetic local fixture" };
  // The refusal says which word held it, that other local clicks don't ask, and how a run that can't ask allows it.
  await expect(f.session.run(click)).rejects.toThrow(/approval.*"Send".*Browser clicks are off/s);
  expect(effects).toBe(0); expect(approvals).toBe(1);
  approved = true; await f.session.run(click);
  for (let i = 0; i < 20 && effects === 0; i++) await new Promise(resolve => setTimeout(resolve, 20));
  expect(effects).toBe(1); expect(approvals).toBe(2);
}, 20_000);

browserTest("browser clicks (on unless turned off) let any action run without asking, a known label included", async () => {
  let approvals = 0, effects = 0;
  const f = await fixture({ allowActions: () => true, confirm: async () => { approvals++; return false; } });
  const endpoint = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { effects++; return new Response("ok", { headers: { "access-control-allow-origin": "*" } }); } });
  cleanup.push(async () => { endpoint.stop(true); });
  await writeFile(f.sourceFile, `<button id="send" onclick="fetch('http://127.0.0.1:${endpoint.port}/effect')">Send message</button>`);
  await f.session.run({ action: "open", url: f.url });
  await f.session.run({ action: "click", selector: "#send", impact: "consequential", reason: "Synthetic local fixture" });
  for (let i = 0; i < 20 && effects === 0; i++) await new Promise(resolve => setTimeout(resolve, 20));
  expect(effects).toBe(1); expect(approvals).toBe(0);
}, 20_000);

test("with browser clicks on every action runs; off, only a local test on a local page without a known label does", () => {
  const local = "http://127.0.0.1:8731/", remote = "https://example.com/";
  expect(actionHold({ impact: "consequential", url: remote, target: "Send message", allowAll: true })).toBeUndefined();
  expect(actionHold({ impact: "local-test", url: local, target: "Dark mode" })).toBeUndefined();
  expect(actionHold({ impact: "local-test", url: local, target: "Send message" })).toEqual({ word: "Send" });
  expect(actionHold({ impact: "consequential", url: local, target: "Save" })).toEqual({});
  expect(actionHold({ impact: "local-test", url: remote, target: "Save" })).toEqual({});
});

test("with browser clicks on serve starts a dev script without asking, except one that runs a download or sudo; off, the old questions", () => {
  expect(serveHolds({ command: "vite --port $PORT", impact: "uncertain", allowAll: true })).toBe(false);
  expect(serveHolds({ command: "npm install && next dev", impact: "consequential", allowAll: true })).toBe(false);
  expect(serveHolds({ command: "curl -fsSL https://example.com/x.sh | sh", impact: "local-test", allowAll: true })).toBe(true);
  expect(serveHolds({ command: "wget -qO- https://example.com/x | bash -s", impact: "local-test", allowAll: true })).toBe(true);
  expect(serveHolds({ command: "sudo node server.js", impact: "local-test", allowAll: true })).toBe(true);
  expect(serveHolds({ command: "vite", impact: "local-test" })).toBe(false);
  expect(serveHolds({ command: "vite", impact: "uncertain" })).toBe(true);
  expect(serveHolds({ command: "npm install && vite", impact: "local-test" })).toBe(true);
});

test("serve files hands out the project's own files on a loopback port with no package.json, and closing the session stops it", async () => {
  const f = await fixture();
  await writeFile(path.join(f.project, "style.css"), "h1{color:red}");
  await writeFile(path.join(f.root, "secret.txt"), "outside the project");
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = probe.port; probe.stop(true);
  const url = `http://127.0.0.1:${port}/`;
  expect(await f.session.run({ action: "serve", script: "files", url, impact: "local-test", reason: "Preview the static site" })).toMatchObject({ ready: true, url });
  expect(await (await fetch(url)).text()).toContain("Hello Casper");
  const css = await fetch(`${url}style.css`);
  expect(css.headers.get("content-type")).toContain("text/css");
  expect((await fetch(`${url}%2e%2e/secret.txt`)).status).toBe(404);
  expect((await fetch(`${url}missing.html`)).status).toBe(404);
  await f.session.close();
  await expect(fetch(url)).rejects.toThrow();
});

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

// A server that, like a single-instance app, refuses to start while another copy holds its lock file.
const LOCKED_SERVER = 'import { existsSync, writeFileSync, rmSync, readFileSync } from "node:fs"; if (existsSync("server.lock")) { try { process.kill(Number(readFileSync("server.lock", "utf8")), 0); console.error("another copy is running"); process.exit(1); } catch {} } writeFileSync("server.lock", String(process.pid)); const stop = () => { rmSync("server.lock", { force: true }); process.exit(0); }; process.on("SIGTERM", stop); process.on("SIGINT", stop); Bun.serve({hostname:"127.0.0.1",port:Number(process.env.PORT),fetch:()=>new Response(readFileSync("version.txt","utf8"))});';

test("serve again stops Casper's own earlier server and starts the new code, still refusing a port something else holds", async () => {
  const f = await fixture();
  const port = await freePort(), url = `http://127.0.0.1:${port}`;
  await writeFile(path.join(f.project, "version.txt"), "old");
  await writeFile(path.join(f.project, "dev.ts"), LOCKED_SERVER);
  await writeFile(path.join(f.project, "package.json"), JSON.stringify({ scripts: { dev: `${process.execPath} dev.ts` } }));
  await f.session.run({ action: "serve", script: "dev", url, impact: "local-test", reason: "Synthetic project" });
  expect(await (await fetch(url)).text()).toBe("old");
  await writeFile(path.join(f.project, "version.txt"), "new");
  await f.session.run({ action: "serve", script: "dev", url, impact: "local-test", reason: "Server code changed" });
  expect(await (await fetch(url)).text()).toBe("new");
  // Another process's port is still never taken over.
  await expect(f.session.run({ action: "serve", script: "dev", url: f.url, impact: "local-test", reason: "Synthetic project" })).rejects.toThrow("already in use");
  await f.session.close();
  await expect(fetch(url)).rejects.toThrow();
  expect((await fetch(f.url)).status).toBe(200);
}, 20_000);

test("with the session's services, serve runs in the page checks' slot: a page check reuses it and no second copy starts", async () => {
  const { ServiceManager } = await import("../src/services/manager");
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-browser-slot-")));
  cleanup.push(() => removeTempDir(root));
  const project = path.join(root, "project"), state = path.join(root, "state");
  await mkdir(project); await mkdir(state);
  await writeFile(path.join(project, "version.txt"), "old");
  await writeFile(path.join(project, "dev.ts"), LOCKED_SERVER);
  await writeFile(path.join(project, "package.json"), JSON.stringify({ scripts: { dev: `${process.execPath} dev.ts`, start: `${process.execPath} dev.ts` } }));
  const services = new ServiceManager({ projectRoot: project, services: {} });
  cleanup.push(() => services.close());
  const session = new BrowserSession({ projectRoot: project, stateDirectory: state, services: () => services });
  cleanup.push(() => session.close());
  const port = await freePort(), url = `http://127.0.0.1:${port}/`;
  expect(await session.run({ action: "serve", script: "start", url, impact: "local-test", reason: "Synthetic project" })).toMatchObject({ ready: true, url });
  expect(services.status()).toMatchObject([{ name: "web", state: "ready", origin: `http://127.0.0.1:${port}` }]);
  const first = services.status()[0]!.pid;
  // Code changed: serve again restarts the same slot (the lock is released first, so the new copy starts).
  await writeFile(path.join(project, "version.txt"), "new");
  await session.run({ action: "serve", script: "start", url, impact: "local-test", reason: "Server code changed" });
  expect(services.status()[0]!.pid).not.toBe(first);
  expect(await (await fetch(url)).text()).toBe("new");
  // The page check's own spec for the slot: it restarts this server in place, on the same port, never beside it.
  services.ensureSlot("web", { command: `${process.execPath} dev.ts`, port: "auto", ready: { http: "/" }, timeoutMs: 10_000 });
  await services.ensureFresh("web", new AbortController().signal);
  expect(services.status()).toMatchObject([{ name: "web", state: "ready", origin: `http://127.0.0.1:${port}` }]);
  expect(await (await fetch(url)).text()).toBe("new");
  // The browser session ends with the task: its server stops.
  await session.close();
  await expect(fetch(url)).rejects.toThrow();
}, 30_000);

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
  await expect(f.session.run({ action: "replay", id: baseline.id, scenario: { name: "Easier", url: f.url, viewport: { width: 800, height: 600 }, steps: [], assertions: [{ kind: "visible", selector: "body" }] } }))
    .rejects.toThrow("replay runs the recorded scenario unchanged");
}, 25_000);

browserTest("an end replay restarts Casper's own server after putting the data back, so an app that reads it only at start sees it", async () => {
  const f = await fixture();
  // Reads data.json once at start and keeps the count in memory, as many small apps do.
  await writeFile(path.join(f.project, "dev.ts"), `import { readFileSync, writeFileSync } from "node:fs";
let rows: number[] = []; try { rows = JSON.parse(readFileSync("data.json", "utf8")); } catch {}
Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PORT), fetch(request) {
  if (new URL(request.url).pathname === "/add") { rows.push(rows.length); writeFileSync("data.json", JSON.stringify(rows)); return new Response(String(rows.length)); }
  return new Response('<!doctype html><button id="add" onclick="fetch(\\'/add\\',{method:\\'POST\\'}).then(r=>r.text()).then(t=>{document.querySelector(\\'#total\\').textContent=t})">Add</button><p id="total">' + rows.length + '</p>', { headers: { "content-type": "text/html" } });
} });`);
  await writeFile(path.join(f.project, "package.json"), JSON.stringify({ scripts: { dev: `${process.execPath} dev.ts` } }));
  const url = `http://127.0.0.1:${await freePort()}`;
  expect(await f.session.run({ action: "serve", script: "dev", url, impact: "local-test", reason: "Synthetic project" })).toMatchObject({ ready: true });
  const add = (name: string, expected: string) => f.session.run({ action: "check", scenario: { name, url,
    steps: [{ action: "click", selector: "#add", impact: "local-test", reason: "adds a test row" }], assertions: [{ kind: "text", selector: "#total", expected }] } });
  expect(await add("first row", "1")).toMatchObject({ status: "pass" });
  expect(await add("second row", "2")).toMatchObject({ status: "pass" });
  // The AI's own rows, through the running app: it now holds 4 in memory.
  for (let i = 0; i < 2; i++) await fetch(`${url}/add`, { method: "POST" });
  f.session.invalidate();
  await f.session.replayStale(0);
  const report = await f.session.report();
  expect(report.checks.map(check => [check.name, check.status, check.notes ?? []])).toEqual([["first row", "pass", []], ["second row", "pass", []]]);
  expect(JSON.parse(await readFile(path.join(f.project, "data.json"), "utf8"))).toEqual([0, 1, 2, 3]);
  // Restarted after the last restore too: the app holds the AI's data again.
  expect(await (await fetch(url)).text()).toContain('<p id="total">4</p>');
}, 60_000);

browserTest("an end replay starts from the data its check was recorded with, and the data the AI left comes back after", async () => {
  const f = await fixture();
  // The app's own server keeps a count in data.json and reads it on every request, like a small JSON-file app.
  const data = path.join(f.project, "data.json");
  const count = async () => { try { return (JSON.parse(await readFile(data, "utf8")) as number[]).length; } catch { return 0; } };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname === "/add") { const next = await count() + 1; await writeFile(data, JSON.stringify([...Array(next).keys()])); return new Response(String(next)); }
    return new Response(`<!doctype html><button id="add" onclick="fetch('/add',{method:'POST'}).then(r=>r.text()).then(t=>{document.querySelector('#total').textContent=t})">Add</button><p id="total">${await count()}</p>`, { headers: { "content-type": "text/html" } });
  } });
  cleanup.push(async () => { server.stop(true); });
  const add = (name: string, expected: string) => f.session.run({ action: "check", scenario: { name, url: `http://127.0.0.1:${server.port}`,
    steps: [{ action: "click", selector: "#add", impact: "local-test", reason: "adds a test row" }],
    assertions: [{ kind: "text", selector: "#total", expected }] } });
  // Written as a chain: each check expects the total the one before left.
  expect(await add("first row", "1")).toMatchObject({ status: "pass" });
  expect(await add("second row", "2")).toMatchObject({ status: "pass" });
  // The AI then adds rows of its own, and a command makes both checks stale.
  await writeFile(data, JSON.stringify([0, 1, 2, 3, 4]));
  f.session.invalidate();
  await f.session.replayStale(0);
  const report = await f.session.report();
  expect(report.checks.map(check => [check.name, check.status])).toEqual([["first row", "pass"], ["second row", "pass"]]);
  // Casper doesn't run this server: the files were put back, and the check says the app may hold other data.
  expect(report.checks[0]!.notes?.some(note => note.includes("Casper doesn't run this server"))).toBe(true);
  expect(await count()).toBe(5);
}, 60_000);

browserTest("at the end Casper replays checks that ran before a later edit: a pass counts, a break fails, a fresh check is left alone", async () => {
  const f = await fixture();
  const html = (saved: string) => `<!doctype html><button id="save" onclick="document.querySelector('#status').textContent='${saved}'">Save</button><p id="status">Not saved</p>`;
  await writeFile(f.sourceFile, html("Saved"));
  const scenario = { name: "Save", url: f.url, scope: { inputs: ["index.html"] }, steps: [{ action: "click", selector: "#save", impact: "local-test", reason: "Synthetic save" }],
    assertions: [{ kind: "text", selector: "#status", expected: "Saved" }] };
  const recorded = await f.session.run({ action: "check", scenario });
  expect(recorded).toMatchObject({ status: "pass", freshness: "fresh" });
  // Nothing ran since: nothing to replay, the check stays as it was.
  await f.session.replayStale(0);
  expect(await f.session.report()).toMatchObject({ status: "pass", checks: [{ id: recorded.id, status: "pass", freshness: "fresh" }] });
  // A later edit that keeps the page working: the replay counts it.
  f.session.invalidate();
  expect(await f.session.report()).toMatchObject({ status: "incomplete", checks: [{ freshness: "stale" }] });
  await f.session.replayStale(0);
  expect(await f.session.report()).toMatchObject({ status: "pass", checks: [{ id: recorded.id, status: "pass", freshness: "fresh", baseline: "pass" }] });
  // A later edit that breaks it: the replay reports the failure with its evidence.
  await writeFile(f.sourceFile, html("Broken"));
  f.session.invalidate();
  await f.session.replayStale(0);
  expect(await f.session.report()).toMatchObject({ status: "fail", checks: [{ status: "fail", assertions: [{ status: "fail", actual: "Broken" }] }] });
}, 30_000);

browserTest("the host's one repair retry reruns a fresh failed id without edits, but never retries an uncertain step", async () => {
  const f = await fixture({ allowActions: () => true });
  await writeFile(f.sourceFile, '<!doctype html><button id="save">Save</button><p id="status">Broken</p>');
  const scenario = { name: "Save", url: f.url, scope: { inputs: ["index.html"] }, steps: [],
    assertions: [{ kind: "text", selector: "#status", expected: "Saved" }] };
  const failed = await f.session.run({ action: "check", scenario });
  const uncertain = await f.session.run({ action: "check", scenario: { ...scenario, name: "uncertain",
    steps: [{ action: "click", selector: "#save", impact: "uncertain", reason: "Unsure" }] } });
  expect(failed).toMatchObject({ status: "fail", freshness: "fresh" });
  const replayed: string[] = [];
  await f.session.replayStale(0, undefined, (_name, id) => replayed.push(id));
  expect(replayed).toEqual([]);
  const retry = new Set([String(failed.id), String(uncertain.id)]);
  await f.session.replayStale(0, undefined, (_name, id) => replayed.push(id), retry);
  expect(replayed).toEqual([String(failed.id), String(uncertain.id)]);
  // Unattended actionHold refuses the uncertain step, leaving its original failed evidence unchanged.
  expect((await f.session.report()).checks).toMatchObject([{ id: failed.id, status: "fail", freshness: "fresh" },
    { id: uncertain.id, status: "fail", freshness: "fresh" }]);
  // The time filter still applies to forced retries from an earlier task.
  replayed.length = 0;
  await f.session.replayStale(performance.now(), undefined, (_name, id) => replayed.push(id), retry);
  expect(replayed).toEqual([]);
}, 30_000);

browserTest("the end replay never asks: a step that needs the person, or a closed browser, keeps the check as it was", async () => {
  const approvals: unknown[] = [];
  const f = await fixture({ allowActions: () => false, confirm: async request => { approvals.push(request); return true; } });
  await writeFile(f.sourceFile, '<!doctype html><button id="go" onclick="document.querySelector(\'#out\').textContent=\'done\'">Go</button><p id="out"></p>');
  const recorded = await f.session.run({ action: "check", scenario: { name: "Asks", url: f.url, scope: { inputs: ["index.html"] },
    steps: [{ action: "click", selector: "#go", impact: "uncertain", reason: "Unsure" }], assertions: [{ kind: "text", selector: "#out", expected: "done" }] } });
  expect(recorded).toMatchObject({ status: "pass" });
  expect(approvals).toHaveLength(1);
  f.session.invalidate();
  await f.session.replayStale(0);
  expect(approvals).toHaveLength(1);
  expect(await f.session.report()).toMatchObject({ status: "incomplete", checks: [{ status: "pass", freshness: "stale" }] });
  await f.session.close();
  await f.session.replayStale(0);
  expect(await f.session.report()).toMatchObject({ status: "incomplete", checks: [{ status: "pass", freshness: "stale" }] });
}, 30_000);

browserTest("with Browser clicks off the end replay never presses a local \"Send\" button: the check stays as it was", async () => {
  const f = await fixture({ allowActions: () => false, confirm: async () => true });
  await writeFile(f.sourceFile, '<!doctype html><button id="go" onclick="document.querySelector(\'#out\').textContent=\'done\'">Send</button><p id="out"></p>');
  const send = await f.session.run({ action: "check", scenario: { name: "send", url: f.url, scope: { inputs: ["index.html"] },
    steps: [{ action: "click", selector: "#go", impact: "local-test", reason: "Test" }], assertions: [{ kind: "text", selector: "#out", expected: "done" }] } });
  expect(send).toMatchObject({ status: "pass" });
  f.session.invalidate();
  await f.session.replayStale(0);
  expect(await f.session.report()).toMatchObject({ status: "incomplete", checks: [{ status: "pass", freshness: "stale" }] });
}, 30_000);

browserTest("the end replay keeps to this task's local tests, even with Browser clicks on", async () => {
  const asked: unknown[] = [];
  const f = await fixture({ allowActions: () => true, confirm: async request => { asked.push(request); return true; } });
  await writeFile(f.sourceFile, '<!doctype html><button id="go" onclick="document.querySelector(\'#out\').textContent=\'done\'">Send</button><p id="out"></p>');
  const step = (impact: string) => ({ name: impact, url: f.url, scope: { inputs: ["index.html"] },
    steps: [{ action: "click", selector: "#go", impact, reason: "Test" }], assertions: [{ kind: "text", selector: "#out", expected: "done" }] });
  const uncertain = await f.session.run({ action: "check", scenario: step("uncertain") });
  expect(uncertain).toMatchObject({ status: "pass" });
  const local = await f.session.run({ action: "check", scenario: { ...step("local-test"), name: "local", steps: [], assertions: [{ kind: "visible", selector: "#go" }] } });
  expect(local).toMatchObject({ status: "pass" });
  // A local test of the "Send" button: with clicks on it ran for the model, so Casper's replay runs it too.
  const send = await f.session.run({ action: "check", scenario: { ...step("local-test"), name: "send" } });
  expect(send).toMatchObject({ status: "pass" });
  f.session.invalidate();
  // The uncertain "Send" click ran with clicks on when the model asked; Casper's own replay never repeats it, or asks.
  await f.session.replayStale(0);
  expect(asked).toHaveLength(0);
  const all = (await f.session.report()).checks;
  expect(all.find(c => c.id === uncertain.id)).toMatchObject({ freshness: "stale" });
  expect(all.find(c => c.id === local.id)).toMatchObject({ freshness: "fresh" });
  expect(all.find(c => c.id === send.id)).toMatchObject({ status: "pass", freshness: "fresh" });
  // A check from before this task started is left alone.
  f.session.invalidate();
  await f.session.replayStale(performance.now());
  expect((await f.session.report()).checks.find(c => c.id === local.id)).toMatchObject({ freshness: "stale" });
}, 30_000);

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

browserTest("the page load looks at phone width: a too-wide page and a squashed input are found; a page that fits has none", async () => {
  const f = await fixture();
  // The bugs a benchmark judge found: an input whose flex-basis 0 collapses it in a column (49px on a desktop, 20px on a
  // phone, its text still fits), and a table wider than the phone.
  await writeFile(f.sourceFile, `<!doctype html><meta name="viewport" content="width=device-width"><style>
    .row{display:flex;gap:8px} .row input{width:0;flex:1;font-size:14px;height:49px;box-sizing:border-box;border:1px solid}
    @media (max-width:480px){.row input{height:auto;min-height:0}}
    @media (max-width:480px){.row{flex-direction:column}} table{width:650px}</style>
    <div class="row"><input id="address" value="10.1.2.3/22"><button>Go</button></div><table><tr><td>10.1.0.0/24</td></tr></table>`);
  const bad = await f.session.load(`${f.url}/`, new AbortController().signal);
  expect(bad.phone).toMatchObject({ viewport: 390 });
  expect(bad.phone!.squashed).toEqual([expect.stringMatching(/^input#address \(\d+px tall; 49px on a wider screen\)$/)]);
  expect(bad.phone!.pageWidth).toBeGreaterThan(390);
  await writeFile(f.sourceFile, `<!doctype html><meta name="viewport" content="width=device-width"><input id="address" style="width:100%;box-sizing:border-box"><p>fits</p>`);
  expect((await f.session.load(`${f.url}/`, new AbortController().signal)).phone).toEqual({ viewport: 390, pageWidth: 390, squashed: [] });
}, 30_000);

browserTest("the page load notes accessibility basics: alt, labels, button names, contrast below WCAG AA, lang", async () => {
  const f = await fixture();
  await writeFile(f.sourceFile, `<!doctype html><html><meta name="viewport" content="width=device-width"><title>a11y</title>
    <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="20" height="20"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="" width="20" height="20">
    <input id="email" placeholder="Email"><input id="name" aria-label="Name"><label>City <input id="city"></label><input type="hidden" name="t">
    <button></button><button aria-label="Close"></button><button><svg width="10" height="10"></svg></button><button>Save</button>
    <p style="color:#bbb;background:#fff">faint words</p><p style="color:#222;background:#fff">plain words</p>
    <p style="color:#777">gray words, 4.48:1</p><p style="color:#888;font-size:24px">large gray words, 3.5:1</p><b style="color:#888;font-size:19px">bold gray words</b></html>`);
  const bad = await f.session.load(`${f.url}/`, new AbortController().signal);
  // WCAG AA: 4.5:1 for body text, 3:1 for large text (24px, or 18.66px bold); the worst pair is named.
  expect(bad.a11y).toEqual({ lang: false, images: 1, inputs: 1, buttons: 2, contrast: { count: 2, worst: 1.9, colors: "#bbbbbb on #ffffff" } });
  await writeFile(f.sourceFile, `<!doctype html><html lang="en"><title>ok</title><label for="q">Search</label><input id="q"><button>Go</button><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="Logo"><p>words</p></html>`);
  expect((await f.session.load(`${f.url}/`, new AbortController().signal)).a11y).toEqual({ lang: true, images: 0, inputs: 0, buttons: 0, contrast: { count: 0, worst: 0 } });
}, 30_000);

const NO_ART = { noViewBox: [], noName: [], fixedColors: [], fixedFiles: [] };
browserTest("the page load names exact facts: images that didn't load, one picture on several cards, what runs past a phone screen, small tap targets", async () => {
  const f = await fixture();
  const card = (src: string, label: string) => `<div class="card"><img src="${src}" alt="${label}"><p>${label}</p><a class="buy" href="#b">Buy</a></div>`;
  await writeFile(f.sourceFile, `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><style>
    .card img{width:100px;height:100px} .wide{width:600px;height:10px} nav a{display:inline-block;width:30px;height:20px}
    .card .buy{display:inline-block;min-width:44px;min-height:44px} .scroller{overflow-x:auto} .scroller div{width:900px}</style>
    <div class="cards">${card("/bean.svg", "Ethiopia")}${card("/bean.svg", "Colombia")}${card("/bean.svg", "Kenya")}${card("/other.svg", "Peru")}</div>
    <img src="/missing.png" alt="Roaster" width="60" height="60">
    <ul><li><img src="/tick.svg" alt="" width="16" height="16">fresh</li><li><img src="/tick.svg" alt="" width="16" height="16">fast</li></ul>
    <div class="wide"></div><div class="scroller"><div>a wide row that scrolls on purpose</div></div>
    <nav><a href="#a">A</a><a id="menu" href="#m">M</a></nav><p>Read <a href="#c">more</a> about it.</p>
    <div><img src="/logo.svg" alt="Logo" width="100" height="60"></div><div><p>hi</p></div><div><img src="/logo.svg" alt="Logo" width="100" height="60"></div>
    <nav><a href="/a">Home</a> <a href="/b">About</a> | <a href="/c">Contact</a></nav></html>`);
  const load = await f.session.load(`${f.url}/`, new AbortController().signal);
  // A small icon used on each list item is not a repeated product picture, nor is a logo in plain boxes (a header and a
  // footer); a link inside a sentence is not a tap target, but each link of a menu of plain links is.
  expect(load.look).toEqual({ brokenImages: ["/missing.png"], repeatedImages: [{ src: "/bean.svg", items: 3 }],
    overflow: ["div.wide"], smallTargets: { count: 5, names: ['a "A"', "a#menu", 'a "Home"'] }, art: NO_ART });
  await writeFile(f.sourceFile, `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><img src="/logo.svg" alt="Logo" width="60" height="60"><p>words</p><button style="width:48px;height:48px">Go</button></html>`);
  expect((await f.session.load(`${f.url}/`, new AbortController().signal)).look).toEqual({ brokenImages: [], repeatedImages: [], overflow: [], smallTargets: { count: 0, names: [] }, art: NO_ART });
}, 30_000);

browserTest("the page load notes what feels wrong to use: developer text, a focus ring round the page, a huge phone footer, a control under a fixed bar; a clean twin has none", async () => {
  const f = await fixture();
  await writeFile(f.sourceFile, `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><style>
    main:focus{outline:3px solid #36f} .bar{position:fixed;bottom:0;left:0;right:0;height:200px;background:#eee} footer{height:600px}</style>
    <main tabindex="-1" id="content"><p>Total: undefined</p><p>[object Object]</p><p>You have 1 bags</p></main>
    <footer><a href="/contact">Contact</a></footer><p><button>Pay</button></p><div class="bar">Added to bag</div>
    <script>document.getElementById("content").focus()</script></html>`);
  expect((await f.session.load(`${f.url}/`, new AbortController().signal)).feel).toEqual({ devText: ["Total: undefined", "[object Object]", "You have 1 bags"],
    shift: { score: 0, moved: [], unsized: [] }, focusRing: "main#content", footer: 600, covered: ['button "Pay" (under div.bar)'] });
  await writeFile(f.sourceFile, `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width">
    <p>Ref 3f2a9c1e-1b2c-4d5e-8f90-1234567890ab</p><p>Opens 9:00 Europe/London</p><p>Posted 2026-10-11T09:30:00Z</p></html>`);
  expect((await f.session.load(`${f.url}/`, new AbortController().signal)).feel!.devText).toEqual(["3f2a9c1e-1b2c-4d5e-8f90-123456", "Opens 9:00 Europe/London", "Posted 2026-10-11T09:30:00Z"]);
  // Code, a time-zone picker, "1 glass", "Step 1 is", "$1 drinks", "table 1 seats 4", a field focused on load, a card's own footer, a dialog over a button
  // and a picture sized by CSS that arrives late are all fine.
  await writeFile(f.sourceFile, `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><style>
    .card footer{height:600px} dialog{position:fixed;bottom:0;margin:0;width:100%;height:60px;border:0}</style>
    <p>Returns <code>undefined</code></p><label>Time zone <select><option>Europe/London</option></select></label>
    <p>1 glass of water</p><p>Step 1 is easy</p><p>Happy hour: $1 drinks</p><p>table 1 seats 4, option 1 gives more</p><img src="/late-cup.svg" alt="Cup" style="width:200px;height:200px">
    <input autofocus aria-label="Search"><article class="card"><p>Bean</p><footer>Card footer</footer></article>
    <p><button>Open</button></p><dialog open>Saved</dialog></html>`);
  expect((await f.session.load(`${f.url}/`, new AbortController().signal)).feel).toEqual({ devText: [], shift: { score: 0, moved: [], unsized: [] }, covered: [] });
}, 30_000);

browserTest("developer text in a field's label or a fieldset's legend is noted; the same words as a field's value, placeholder or option are not", async () => {
  const f = await fixture();
  await writeFile(f.sourceFile, `<!doctype html><html lang="en"><form><label for="when">Date &amp; time (Europe/London)</label><input id="when">
    <fieldset><legend>Size: {{size}}</legend><label><input type="radio" name="size"> Small</label></fieldset><label>Pick [object Object] <select><option>One</option></select></label></form></html>`);
  expect((await f.session.load(`${f.url}/`, new AbortController().signal)).feel!.devText).toEqual(["Date & time (Europe/London)", "Size: {{size}}", "Pick [object Object]"]);
  await writeFile(f.sourceFile, `<!doctype html><html lang="en"><form><label for="when">Date and time</label><input id="when" value="2026-10-11T09:30">
    <label for="zone">Time zone</label><input id="zone" placeholder="Europe/Paris"><fieldset><legend>Size</legend><label><input type="radio" name="size" value="{{size}}"> Small</label></fieldset>
    <label>Zone <select><option>Europe/London</option></select></label><textarea aria-label="Notes">undefined</textarea></form></html>`);
  expect((await f.session.load(`${f.url}/`, new AbortController().signal)).feel!.devText).toEqual([]);
}, 30_000);

browserTest("the page load lists links whose query makes a choice; a light load with those choices names the ones the page does not show as chosen", async () => {
  const f = await fixture();
  await writeFile(f.sourceFile, `<!doctype html><html lang="en"><a href="/book?staff=ana-sousa">Ana</a><a href="/book?service=cut&amp;utm_source=mail">Cut</a>
    <a href="/shop?page=2">Next</a><a href="/cart?action=add&amp;id=3">Add</a><a href="/list?status=delete">Bin</a><a href="/go?next=/home">Go</a>
    <a href="/menu.pdf?v=1">Menu</a><a href="/book?staff=ana-sousa#top">Top</a><a href="https://example.com/?staff=ana">Elsewhere</a></html>`);
  expect((await f.session.load(`${f.url}/`, new AbortController().signal)).choiceLinks).toEqual(["/book?staff=ana-sousa", "/book?service=cut&utm_source=mail"]);
  // They take turns by the keys they set, so the first few cover every kind of choice.
  expect(choiceLinks(["/book?service=a", "/book?service=b", "/book?service=c", "/book?staff=x", "/book?staff=y", "/book?staff=y"], `${f.url}/`))
    .toEqual(["/book?service=a", "/book?staff=x", "/book?service=b", "/book?staff=y", "/book?service=c"]);
  const light = (choices: Array<[string, string]>) => f.session.load(`${f.url}/book`, new AbortController().signal, { light: true, choices });
  // The page ignores the choice: nothing shows ana-sousa, and the staff field keeps its first option.
  await writeFile(f.sourceFile, `<!doctype html><html lang="en"><h1>Book</h1><select name="staff"><option value="any">Anyone</option><option value="ana-sousa">Ana Sousa</option></select>
    <select name="size"><option value="1">Small</option><option value="2">Large</option></select><input type="hidden" name="date" value="2026-10-12"></html>`);
  expect((await light([["staff", "ana-sousa"], ["size", "2"], ["date", "2026-10-12"], ["id", "7"]])).unchosen).toEqual(["ana-sousa", "2", "2026-10-12"]);
  // Clean twin: a selected option, a checked radio's label, a field's value or the words near the top show each choice.
  await writeFile(f.sourceFile, `<!doctype html><html lang="en"><h1>Book with Ana Sousa</h1><p>Monday 12 October</p>
    <select name="size"><option value="1">Small</option><option value="2" selected>Large</option></select>
    <label><input type="radio" name="service" value="c1" checked> Cut and finish</label><input name="ref" value="Spring offer"></html>`);
  expect((await light([["staff", "ana-sousa"], ["size", "2"], ["date", "2026-10-12"], ["service", "cut-and-finish"], ["ref", "spring-offer"], ["id", "7"],
    ["order", "a1b2c3d4"], ["user_id", "ana-sousa-x"]])).unchosen).toBeUndefined();
}, 30_000);

browserTest("a picture that arrives late with no size makes the layout jump and is named; the same picture with width and height does not", async () => {
  const f = await fixture();
  const page = (size: string) => `<!doctype html><html lang="en"><img src="/late-hero.svg" alt="Hero"${size}>
    <p id="intro">Fresh beans, roasted this week.</p><p>${"Words. ".repeat(300)}</p><button>Buy</button></html>`;
  await writeFile(path.join(f.project, "late-hero.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="700" viewBox="0 0 1200 700"><rect width="1200" height="700"/></svg>');
  await writeFile(f.sourceFile, page(""));
  const jumped = (await f.session.load(`${f.url}/`, new AbortController().signal)).feel!.shift;
  expect(jumped.score).toBeGreaterThanOrEqual(0.1);
  expect(jumped.moved).toContain("p#intro");
  expect(jumped.unsized).toEqual(["/late-hero.svg"]);
  await writeFile(f.sourceFile, page(' width="1200" height="700"'));
  expect((await f.session.load(`${f.url}/`, new AbortController().signal)).feel!.shift.score).toBeLessThan(0.1);
}, 30_000);

browserTest("the page load checks drawn pictures: no viewBox, no name, and icons whose colors stay light in dark mode; a rich illustration gets no note", async () => {
  const f = await fixture();
  const svg = (attributes: string, inside: string) => `<svg xmlns="http://www.w3.org/2000/svg" ${attributes}>${inside}</svg>`;
  // A polished illustration: the skill's kit (gradients, filters, patterns, fixed colors), words on a gauge and more than 150 shapes.
  const ticks = Array.from({ length: 160 }, (_, index) => `<rect x="${index % 40}" y="${100 + Math.floor(index / 40)}" width=".5" height=".5" fill="#333"/>`).join("");
  const kit = await readFile(path.join(import.meta.dir, "../skills/web/frontend/illustration-kit.svg"), "utf8");
  const illustration = kit.replace("<svg ", '<svg id="espresso" width="480" height="240" ').replace("</svg>", `<text x="20" y="20">9 bar</text>${ticks}</svg>`);
  await writeFile(path.join(f.project, "flat-art.svg"), svg('width="120" height="120"', '<circle cx="50" cy="50" r="40" fill="#c84"/>'));
  await writeFile(path.join(f.project, "flat-icon.svg"), svg('viewBox="0 0 16 16"', '<circle cx="8" cy="8" r="8" fill="#c84"/>'));
  await writeFile(path.join(f.project, "themed-icon.svg"), svg('viewBox="0 0 16 16"', '<style>circle{fill:#c84}@media (prefers-color-scheme:dark){circle{fill:#fc8}}</style><circle cx="8" cy="8" r="8"/>'));
  const page = (dark: boolean) => `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><style>
    :root{--bg:#fff;--ink:#222} ${dark ? "@media (prefers-color-scheme:dark){:root{--bg:#111;--ink:#eee}}" : ""} body{background:var(--bg);color:var(--ink)}</style>
    ${illustration}
    ${svg('id="unnamed" width="120" height="120" viewBox="0 0 100 100"', '<circle cx="50" cy="50" r="40" fill="var(--ink)"/>')}
    ${svg('id="decor" width="120" height="120" viewBox="0 0 100 100" aria-hidden="true"', '<circle cx="50" cy="50" r="40" fill="#c33"/>')}
    ${svg('id="cart" width="20" height="20" viewBox="0 0 16 16" aria-hidden="true"', '<path d="M1 1h3l2 9h8" fill="none" stroke="#c33"/>')}
    ${svg('id="menu" width="20" height="20" viewBox="0 0 16 16" aria-hidden="true"', '<path d="M1 4h14M1 8h14" stroke="currentColor"/>')}
    ${svg('id="star" width="20" height="20" viewBox="0 0 16 16"', '<path d="M8 1l2 5h5l-4 3 2 5-5-3-5 3 2-5-4-3h5z" fill="currentColor"/>')}
    <button style="color:inherit;background:none">${svg('id="save" width="20" height="20" viewBox="0 0 16 16"', '<path d="M2 2h12v12H2z" fill="currentColor"/>')} Save</button>
    <img src="/flat-art.svg" alt="Bean" width="120" height="120"><img src="/flat-icon.svg" alt="" width="16" height="16">
    <img src="/themed-icon.svg" alt="" width="16" height="16"></html>`;
  await writeFile(f.sourceFile, page(true));
  // The illustration keeps its own colors and gets no note; a big picture with fixed colors is art, not an icon.
  // A small icon needs a name too, unless it is hidden or sits in a control (the button's own words name it).
  expect((await f.session.load(`${f.url}/`, new AbortController().signal)).look!.art).toEqual({ noViewBox: ["/flat-art.svg"],
    noName: ["svg#unnamed", "svg#star"], fixedColors: ["svg#cart"], fixedFiles: ["/flat-icon.svg"] });
  // A page that stays light has no dark mode for the icons to follow.
  await writeFile(f.sourceFile, page(false));
  expect((await f.session.load(`${f.url}/`, new AbortController().signal)).look!.art).toMatchObject({ fixedColors: [], fixedFiles: [] });
}, 30_000);

browserTest("the page load lists the same-origin pages it links to that a GET can safely open; a light load only says whether a page shows anything", async () => {
  const f = await fixture();
  await writeFile(f.sourceFile, `<!doctype html><html lang="en"><a href="/about">About</a><a href="/logout">Log out</a><a href="/account/sign-out">Sign out</a>
    <a href="/search?x=1">Search</a><a href="/faq#top">FAQ</a><a href="#menu">Menu</a><a href="/api/x">API</a><a href="/menu.pdf">Menu PDF</a>
    <a href="/price-list" download>Prices</a><a href="/partners" rel="nofollow">Partners</a><a href="https://example.com/">Elsewhere</a>
    <a href="/">Home</a><a href="/about">About again</a><a href="/cart/remove/3">Remove</a><a href="/menu.html">Menu page</a>
    <a href="/cart/add/3">Add</a><a href="/orders/7/confirm">Confirm</a><a href="/log-off">Log off</a><a href="/address-book">Addresses</a></html>`);
  expect((await f.session.load(`${f.url}/`, new AbortController().signal)).links).toEqual(["/about", "/menu.html", "/address-book"]);
  await writeFile(f.sourceFile, `<!doctype html><html lang="en"><body><div id="root"></div></body></html>`);
  const blank = await f.session.load(`${f.url}/about`, new AbortController().signal, { light: true });
  expect(blank).toMatchObject({ status: 200, blank: true });
  expect(blank.links ?? blank.look ?? blank.phone ?? blank.screenshots).toBeUndefined();
  await writeFile(f.sourceFile, `<!doctype html><html lang="en"><img src="/logo.svg" alt="Logo" width="40" height="40"></html>`);
  expect((await f.session.load(`${f.url}/about`, new AbortController().signal, { light: true })).blank).toBeUndefined();
}, 30_000);

browserTest("a picture file with no length stops being read after 256 KB, and a cancel stops the drawn-picture step", async () => {
  const f = await fixture();
  await writeFile(f.sourceFile, `<!doctype html><html lang="en"><img src="/stream-endless.svg" alt="Big" width="120" height="120"></html>`);
  const started = Date.now();
  expect((await f.session.load(`${f.url}/`, new AbortController().signal)).look!.art).toEqual(NO_ART);
  const read = f.streams.filter(entry => entry.path === "/stream-endless.svg").at(-1)!;
  // Stopped once past the limit, well before the 2 s time limit on each file.
  expect(read.cancelled! - read.started).toBeLessThan(1500);
  // A cancel while a file is being read ends the load at once, not after the file's time limit.
  await writeFile(f.sourceFile, `<!doctype html><html lang="en"><img src="/stream-stuck.svg" alt="Stuck" width="120" height="120"></html>`);
  const controller = new AbortController();
  const before = f.streams.length;
  const work = f.session.load(`${f.url}/`, controller.signal);
  while (f.streams.length < before + 1 && Date.now() - started < 20_000) await new Promise(resolve => setTimeout(resolve, 20));
  const cancelled = Date.now();
  controller.abort();
  await expect(work).rejects.toThrow();
  expect(Date.now() - cancelled).toBeLessThan(1500);
}, 45_000);

browserTest("the drawn-picture step's own reads of picture files never count as failed requests", async () => {
  const f = await fixture();
  // One file it gives up on past 256 KB, one past its 2 s time limit, and one that is gone (named once, not twice).
  await writeFile(f.sourceFile, `<!doctype html><html lang="en"><img src="/stream-endless.svg" alt="Big" width="120" height="120">
    <img src="/stream-stuck.svg" alt="Slow" width="120" height="120"><img src="/gone.svg" alt="Gone" width="120" height="120"></html>`);
  const load = await f.session.load(`${f.url}/`, new AbortController().signal);
  expect(f.streams.map(entry => entry.path).sort()).toEqual(["/stream-endless.svg", "/stream-stuck.svg"]);
  expect(load.failedRequests).toEqual([{ url: `${f.url}/gone.svg`, status: 404 }]);
  expect(load.look!.art).toEqual(NO_ART);
}, 45_000);

browserTest("the contrast note reads colors Chrome keeps as oklch (Tailwind v4's palette): text, background and a see-through color", async () => {
  const f = await fixture();
  const contrast = async (body: string) => {
    await writeFile(f.sourceFile, `<!doctype html><html lang="en"><title>oklch</title>${body}</html>`);
    return (await f.session.load(`${f.url}/`, new AbortController().signal)).a11y?.contrast;
  };
  // The expected ratios come from Ottosson's oklch-to-sRGB formula, not from the browser.
  expect(await contrast(`<p style="color:oklch(0.8 0.02 260);background:oklch(0.95 0.01 260)">faint words</p>`)).toMatchObject({ count: 1, worst: 1.6 });
  expect(await contrast(`<p style="color:oklch(0.75 0 0)">faint words</p>`)).toMatchObject({ count: 1, worst: 2.2 });
  // The dark oklch box is the background, not the white page behind it (#444 on white would be 9.7:1).
  expect(await contrast(`<div style="background:oklch(0.25 0.02 260)"><p style="color:#444">dim words</p></div>`)).toMatchObject({ count: 1, worst: 1.6 });
  // A see-through color keeps its alpha: opaque, this gray would be 18:1 on white.
  expect(await contrast(`<p style="color:oklch(0.3 0 0 / 0.3)">faint words</p>`)).toMatchObject({ count: 1, worst: 1.8 });
  expect(await contrast(`<p style="color:oklch(0.2 0 0);background:oklch(0.98 0 0)">plain words</p>`)).toEqual({ count: 0, worst: 0 });
  // Just below AA reads as below it: #777 on white is 4.48:1, not "4.5:1"; large text at 2.96:1 is not "3:1".
  expect(await contrast(`<p style="color:#777">gray words</p>`)).toEqual({ count: 1, worst: 4.4, colors: "#777777 on #ffffff" });
  expect(await contrast(`<p style="color:#969696;font-size:24px">big gray words</p>`)).toMatchObject({ count: 1, worst: 2.9 });
}, 45_000);

browserTest("a page check saves a desktop and a phone picture outside the project, private, and none unless asked", async () => {
  const f = await fixture();
  const plain = await f.session.load(`${f.url}/`, new AbortController().signal);
  expect(plain.screenshots).toBeUndefined();
  const load = await f.session.load(`${f.url}/`, new AbortController().signal, { screenshots: true });
  if (!posixModes) { expect(load.screenshots).toBeUndefined(); return; }
  const { desktop, phone } = load.screenshots!;
  for (const file of [desktop!, phone!]) {
    expect(file.startsWith(f.state)).toBe(true);
    expect((await readFile(file)).subarray(1, 4).toString()).toBe("PNG");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  }
  expect(path.basename(desktop!)).toBe("page-1-desktop.png");
  expect(path.basename(phone!)).toBe("page-1-phone.png");
  // The phone picture is the visible screen; the desktop one is the whole page.
  expect((await readFile(phone!)).readUInt32BE(20)).toBe(844);
  // They are not the model's screenshots: its own count stays at 0.
  expect(f.session.status().screenshots).toBe(0);
}, 30_000);

browserTest("the host-only page load reports console errors and the failed same-origin request", async () => {
  const f = await fixture();
  const load = await f.session.load(`${f.url}/`, new AbortController().signal);
  expect(load).toMatchObject({ status: 200, consoleChecked: true });
  expect(load.consoleErrors).toContain("synthetic-console-error");
  // Resource failures are reported as requests, not duplicated as console text.
  expect(load.consoleErrors.some(text => text.startsWith("Failed to load resource"))).toBe(false);
  expect(load.failedRequests).toContainEqual({ url: `${f.url}/missing-api`, status: 503 });
  await expect(f.session.load("https://example.com/", new AbortController().signal)).rejects.toThrow("loopback");
  // The load uses no model operation budget and leaves the model's diagnostics empty.
  expect((await f.session.run({ action: "diagnostics" })).console).toEqual([]);
}, 60_000);

browserTest("the desktop picture is the whole page up to 4000 px, after scrolling so lazy images load", async () => {
  const f = await fixture();
  const height = async (body: string) => {
    await writeFile(f.sourceFile, `<!doctype html><html lang="en"><style>body{margin:0}</style>${body}</html>`);
    const load = await f.session.load(`${f.url}/`, new AbortController().signal, { screenshots: true });
    return load.screenshots ? (await readFile(load.screenshots.desktop!)).readUInt32BE(20) : undefined;
  };
  if (!posixModes) return;
  expect(await height(`<div style="height:2500px">a row below the fold</div>`)).toBe(2500);
  expect(await height(`<div style="height:6000px"></div><img loading="lazy" src="/far.svg" alt="far" width="50" height="50">`)).toBe(4000);
  expect(f.images).toContain("/far.svg");
}, 45_000);

browserTest("select picks an option by value or label and fires change; fill on a <select> says to use select", async () => {
  const f = await fixture({ allowActions: () => true });
  await writeFile(f.sourceFile, `<!doctype html><select id="size" onchange="document.querySelector('#out').textContent=this.value"><option value="sm">Small</option><option value="lg">Large</option></select><p id="out"></p><input id="name">`);
  await f.session.run({ action: "open", url: f.url });
  const act = (action: string, selector: string, value: string) => f.session.run({ action, selector, value, impact: "local-test", reason: "Synthetic fixture" });
  await expect(act("fill", "#size", "lg")).rejects.toThrow("use action select");
  await expect(act("select", "#name", "lg")).rejects.toThrow("Select takes a <select>");
  await expect(act("select", "#size", "Huge")).rejects.toThrow('no option "Huge"; its options are sm (Small), lg (Large)');
  expect(await act("select", "#size", "Large")).toMatchObject({ executed: true, selected: { value: "lg", label: "Large" } });
  const check = await f.session.run({ action: "check", scenario: { name: "Pick small", url: f.url, scope: { inputs: ["index.html"] },
    steps: [{ action: "select", selector: "#size", value: "lg", impact: "local-test", reason: "Synthetic" }, { action: "select", selector: "#size", value: "Small", impact: "local-test", reason: "Synthetic" }],
    assertions: [{ kind: "text", selector: "#out", expected: "sm" }] } });
  expect(check.status).toBe("pass");
}, 20_000);

browserTest("a button below the screen that only appears once scrolled to (a reveal animation) is scrolled into view and clicked", async () => {
  const f = await fixture({ allowActions: () => true });
  await writeFile(f.sourceFile, `<!doctype html><style>html{scroll-behavior:smooth}.reveal{transform:scale(0);transition:transform .3s}.reveal.shown{transform:none}</style>
<div style="height:3000px"></div><section class="reveal"><button id="go" onclick="document.querySelector('#out').textContent='clicked'">Go</button></section><p id="out"></p>
<script>new IntersectionObserver(es => es.forEach(e => e.isIntersecting && e.target.classList.add("shown"))).observe(document.querySelector(".reveal"))</script>`);
  const check = await f.session.run({ action: "check", scenario: { name: "Go below", url: f.url, scope: { inputs: ["index.html"] },
    steps: [{ action: "click", selector: "#go", impact: "local-test", reason: "Synthetic" }], assertions: [{ kind: "text", selector: "#out", expected: "clicked" }] } });
  expect(check.status).toBe("pass");
}, 20_000);

test("a session runs 200 operations and records 24 checks; the check limit says to replay the ids it has", async () => {
  const f = await fixture({ executablePath: "/nonexistent/chrome" });
  const scenario = { name: "Heading", url: f.url, steps: [], assertions: [{ kind: "visible", selector: "h1" }] };
  // A check is recorded before the browser starts, so a missing browser still counts it.
  for (let i = 0; i < 24; i++) await expect(f.session.run({ action: "check", scenario })).rejects.toThrow("Browser was not found");
  await expect(f.session.run({ action: "check", scenario })).rejects.toThrow("Browser check limit reached (24 per session); replay the ids your checks returned");
  for (let i = 25; i < 200; i++) await f.session.run({ action: "diagnostics" });
  await expect(f.session.run({ action: "diagnostics" })).rejects.toThrow("Browser operation limit reached (200 per session)");
});

test("the model's browser tool has no load action; page loads are host-only", async () => {
  const f = await fixture({ executablePath: "/nonexistent/chrome" });
  const schema = browserTool(f.session).inputSchema as { properties: { action: { enum: string[] } } };
  expect(schema.properties.action.enum).not.toContain("load");
  await expect(f.session.run({ action: "load", url: f.url })).rejects.toThrow("Unknown browser action");
  await expect(f.session.load("file:///etc/passwd")).rejects.toThrow();
});
