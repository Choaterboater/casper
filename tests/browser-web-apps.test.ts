import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BrowserSession } from "../src/browser/session";
import { removeTempDir } from "./support/temp-dir";

// Web apps the AI's browser audits: a long "Loading…" splash, components in nested open shadow roots, a sign-in redirect.
const executable = process.env.CASPER_BROWSER_EXECUTABLE ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browserTest = existsSync(executable) ? test : test.skip;
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

/** A panel drawn 1.2 s after the page loads, two shadow roots deep: a title, a state and a button that turns it on. */
const APP = `<!doctype html><title>Home</title><body><div id="splash">Loading…</div><script>
class LightCard extends HTMLElement { constructor() { super(); const root = this.attachShadow({ mode: "open" });
  root.innerHTML = '<span id="state">off</span> <button id="toggle">Toggle</button> <input id="search" placeholder="Find">';
  root.querySelector("#toggle").addEventListener("click", () => { root.querySelector("#state").textContent = "on"; }); } }
class HomePanel extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = '<h2 id="title">Living room</h2><light-card></light-card>'; } }
customElements.define("light-card", LightCard); customElements.define("home-panel", HomePanel);
addEventListener("load", () => setTimeout(() => { document.getElementById("splash").remove(); document.body.append(document.createElement("home-panel")); }, 1200));
</script></body>`;
const PAGES: Record<string, string> = {
  "/app": APP,
  "/still": "<!doctype html><title>Still</title><h1>Nothing moves here</h1><input id=\"field\" value=\"abc\">",
  // Changes every 50 ms, for as long as it is open.
  "/ticking": "<!doctype html><title>Ticking</title><p id=\"n\">0</p><script>let n = 0; setInterval(() => { document.getElementById(\"n\").textContent = String(++n); }, 50);</script>",
  "/forever": "<!doctype html><title>Forever</title><p>Loading…</p>",
  // A page that sends the browser to its sign-in page, as Home Assistant does without a login.
  "/dashboard": "<!doctype html><title>Dashboard</title><p>Loading…</p><script>setTimeout(() => location.replace(\"/auth/authorize?client_id=fixture\"), 300);</script>",
  "/auth/authorize": "<!doctype html><title>Sign in</title><h1>Welcome home!</h1><form><input name=\"username\"><input name=\"password\" type=\"password\"><button>Log in</button></form>",
  // A sign-in form at an address that doesn't say so.
  "/panel": "<!doctype html><title>Panel</title><script>location.replace(\"/welcome\")</script>",
  "/welcome": "<!doctype html><title>Welcome</title><h1>Welcome</h1><form><input type=\"email\" autocomplete=\"username\"><input type=\"password\"><button>Continue</button></form>",
};

async function fixture(options: { settleMs?: number } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-browser-apps-")));
  cleanup.push(() => removeTempDir(root));
  const project = path.join(root, "project"), state = path.join(root, "state");
  await mkdir(project); await mkdir(state);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const page = PAGES[new URL(request.url).pathname];
    return page ? new Response(page, { headers: { "content-type": "text/html", "cache-control": "no-store" } }) : new Response("not found", { status: 404 });
  } });
  cleanup.push(async () => { server.stop(true); });
  const session = new BrowserSession({ projectRoot: project, stateDirectory: state, executablePath: executable, ...options });
  cleanup.push(() => session.close());
  return { session, url: `http://127.0.0.1:${server.port}` };
}

browserTest("inspect and a check wait out a loading splash and read inside nested open shadow roots", async () => {
  const f = await fixture();
  await f.session.run({ action: "open", url: `${f.url}/app` });
  const seen = await f.session.run({ action: "inspect" });
  expect(seen.text).toContain("Living room");
  expect(seen.text).not.toContain("Loading");
  expect(seen.elements).toEqual(expect.arrayContaining([expect.objectContaining({ tag: "BUTTON", selector: "#toggle", inShadowRoot: true })]));
  // A plain selector that matches nothing in the page is looked for in its shadow roots; `>>>` names one inside a host.
  const clicked = await f.session.run({ action: "click", selector: "#toggle", impact: "local-test", reason: "Turn on a fixture light" });
  expect(clicked).toMatchObject({ executed: true });
  expect(clicked.note).toBeUndefined();
  await f.session.run({ action: "fill", selector: "home-panel >>> #search", value: "lamp", impact: "local-test", reason: "Fixture search" });
  const passed = await f.session.run({ action: "check", scenario: { name: "Light turns on", url: `${f.url}/app`, steps: [
    { action: "click", selector: "light-card >>> #toggle", impact: "local-test", reason: "Turn on a fixture light" }],
  assertions: [{ kind: "text", selector: "#state", expected: "on" }, { kind: "text", selector: "pierce/#title", expected: "Living room" }] } });
  expect(passed).toMatchObject({ status: "pass", assertions: [{ status: "pass" }, { status: "pass" }] });
  // With no steps the assertions run on the drawn panel, not the splash.
  const drawn = await f.session.run({ action: "check", scenario: { name: "Panel shows", url: `${f.url}/app`, steps: [], assertions: [{ kind: "visible", selector: "#title" }] } });
  expect(drawn).toMatchObject({ status: "pass" });
}, 40_000);

browserTest("the wait before reading a page ends at its cap on a page that never stops changing or keeps saying Loading", async () => {
  const f = await fixture({ settleMs: 1_500 });
  for (const page of ["/ticking", "/forever"]) {
    await f.session.run({ action: "open", url: `${f.url}${page}` });
    const started = performance.now();
    const seen = await f.session.run({ action: "inspect" });
    const took = performance.now() - started;
    expect(seen.title).toBe(page === "/ticking" ? "Ticking" : "Forever");
    expect(took).toBeGreaterThanOrEqual(1_400);
    // The cap and a busy machine's slack: never the action's own 15 s.
    expect(took).toBeLessThan(6_000);
  }
  // A page that is still settles at once (after its half second of quiet).
  await f.session.run({ action: "open", url: `${f.url}/still` });
  const started = performance.now();
  await f.session.run({ action: "inspect" });
  expect(performance.now() - started).toBeLessThan(1_400);
}, 40_000);

browserTest("a screenshot identical to the last one is free; the limit says what is left and what to do instead", async () => {
  const f = await fixture({ settleMs: 200 });
  await f.session.run({ action: "open", url: `${f.url}/still` });
  const first = await f.session.run({ action: "screenshot" });
  expect(first).toMatchObject({ screenshotsLeft: 15 });
  const again = await f.session.run({ action: "screenshot" });
  expect(again).toMatchObject({ screenshotsLeft: 15, path: first.path });
  expect(String(again.note)).toContain("didn't count");
  expect(f.session.status().screenshots).toBe(1);
  // A page that changes every 50 ms gives a new picture each time.
  await f.session.run({ action: "open", url: `${f.url}/ticking` });
  for (let left = 14; left >= 0; left--) {
    const shot = await f.session.run({ action: "screenshot" });
    expect(shot.note).toBeUndefined();
    expect(shot.screenshotsLeft).toBe(left);
  }
  await expect(f.session.run({ action: "screenshot" })).rejects.toThrow(/limit reached \(16 per session, none left\)\. A retake identical to the last screenshot is free, and a check brings a picture/);
  expect(f.session.status().screenshots).toBe(16);
}, 60_000);

browserTest("a check that ends on a sign-in page is neither a pass nor a failure: it says so and names the signin action", async () => {
  const f = await fixture();
  const redirected = await f.session.run({ action: "check", scenario: { name: "Dashboard shows", url: `${f.url}/dashboard`, steps: [], assertions: [{ kind: "visible", selector: "h1" }] } });
  expect(redirected.status).toBe("incomplete");
  expect(String(redirected.reason)).toContain("went to a sign-in page");
  expect(String(redirected.reason)).toContain("/auth/authorize");
  expect(String(redirected.reason)).toContain("signin action");
  // A step that finds nothing there gives the same plain result, with its id kept for a replay.
  const stepped = await f.session.run({ action: "check", scenario: { name: "Dashboard light", url: `${f.url}/dashboard`, steps: [
    { action: "click", selector: "#lights", impact: "local-test", reason: "Fixture light" }], assertions: [{ kind: "visible", selector: "#lights" }] } });
  expect(stepped.status).toBe("incomplete");
  expect(String(stepped.reason)).toContain("signin action");
  expect(String(stepped.id)).toMatch(/^[0-9a-f-]{36}$/);
  // A username and password form at an address that doesn't say sign-in.
  const form = await f.session.run({ action: "check", scenario: { name: "Panel shows", url: `${f.url}/panel`, steps: [], assertions: [{ kind: "visible", selector: "h1" }] } });
  expect(form.status).toBe("incomplete");
  expect(String(form.reason)).toContain("/welcome");
  // A check of the sign-in page itself is an ordinary check.
  const own = await f.session.run({ action: "check", scenario: { name: "Sign-in shows", url: `${f.url}/auth/authorize`, steps: [], assertions: [{ kind: "visible", selector: "h1" }] } });
  expect(own).toMatchObject({ status: "pass" });
  expect((await f.session.report()).status).toBe("incomplete");
}, 40_000);

browserTest("press takes the keys that move round a page: End, Home, PageUp, PageDown and the arrows", async () => {
  const f = await fixture({ settleMs: 200 });
  await f.session.run({ action: "open", url: `${f.url}/still` });
  for (const key of ["End", "Home", "PageUp", "PageDown", "ArrowLeft", "Delete"]) {
    expect(await f.session.run({ action: "press", selector: "#field", value: key, impact: "local-test", reason: "Fixture key" })).toMatchObject({ executed: true });
  }
  await expect(f.session.run({ action: "press", selector: "#field", value: "F13", impact: "local-test", reason: "Fixture key" }))
    .rejects.toThrow(/Unsupported browser key "F13"; press takes Enter, .*End, PageUp, PageDown/);
}, 30_000);
