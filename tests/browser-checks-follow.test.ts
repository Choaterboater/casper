import { afterEach, expect } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
/** Says Up when the service at argv[2] answers, Down when it doesn't: the start page's status dot, on the AI's own mock. */
const STATUS = `const upstream = process.argv[2];
Bun.serve({ hostname: process.env.HOST ?? "127.0.0.1", port: Number(process.env.PORT), fetch: async () => {
  const up = await fetch(upstream, { signal: AbortSignal.timeout(1000) }).then(response => response.ok, () => false);
  return new Response("<!doctype html><h1>" + (up ? "Up" : "Down") + "</h1>", { headers: { "content-type": "text/html; charset=utf-8" } });
} });
console.log("listening");
`;
/** Reads config/title.yaml once at start and keeps it in memory, as the start page builds did. */
const CACHING = `const title = require("node:fs").readFileSync("config/title.yaml", "utf8").trim();
Bun.serve({ hostname: process.env.HOST ?? "127.0.0.1", port: Number(process.env.PORT), fetch: () => new Response("<!doctype html><h1>" + title + "</h1>", { headers: { "content-type": "text/html; charset=utf-8" } }) });
console.log("listening");
`;

async function setup() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-checks-follow-")));
  cleanup.push(() => removeTempDir(root));
  const project = path.join(root, "project"), state = path.join(root, "state");
  await mkdir(project); await mkdir(state);
  await writeFile(path.join(root, "server.ts"), SERVER);
  await writeFile(path.join(root, "caching.ts"), CACHING);
  await writeFile(path.join(root, "status.ts"), STATUS);
  const command = (words: string, script = "server.ts") => `"${process.execPath}" "${path.join(root, script)}" "${words}"`;
  const services = new ServiceManager({ projectRoot: project, services: {} });
  cleanup.push(() => services.close());
  const session = new BrowserSession({ projectRoot: project, stateDirectory: state, executablePath: executable, services: () => services });
  cleanup.push(() => session.close());
  const signal = new AbortController().signal;
  const scenario = (url: string, expected: string) => ({ name: "Heading", url, steps: [], assertions: [{ kind: "text", selector: "h1", expected }] });
  return { root, project, services, session, command, signal, scenario };
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

browserTest("at the end, a check whose own service stopped is replayed on it, started again, and the service is stopped again after", async () => {
  const { services, session, command, signal, scenario } = await setup();
  const own = await services.startCommand(command("Weather 21°C"), { ready: { log: "listening" } }, signal);
  const passed = await session.run({ action: "check", scenario: scenario(`${own.origin}/`, "Weather 21°C") });
  expect(passed.status).toBe("pass");
  // The AI stops its server; Casper's own server for the project holds other data.
  await services.stop(own.name);
  services.ensureSlot("web", { command: command("Dashboard"), port: "auto", ready: { log: "listening" }, timeoutMs: 10_000 });
  await services.start("web", signal);
  session.invalidate();
  await session.replayStale(0);
  const report = await session.report();
  const replayed = report.checks.find(check => check.id === passed.id)!;
  expect(replayed).toMatchObject({ status: "pass", freshness: "fresh" });
  expect(replayed.gone).toBeUndefined();
  expect(replayed.notes).toContain(`started ${own.name} again for this replay: it had stopped`);
  expect(report.status).toBe("pass");
  // Left as the AI left it.
  expect(services.status().find(service => service.name === own.name)?.state).toBe("stopped");
}, 45_000);

browserTest("a check whose server is gone and can't be started again, and that fails on Casper's server, is stale, not failed; one that already failed stays failed", async () => {
  const { root, services, session, command, signal, scenario } = await setup();
  await writeFile(path.join(root, "own.ts"), SERVER);
  const own = await services.startCommand(command("Weather 21°C", "own.ts"), { ready: { log: "listening" } }, signal);
  // Passed on the AI's own server and its test data; failed there too (a real failure).
  const passed = await session.run({ action: "check", scenario: scenario(`${own.origin}/`, "Weather 21°C") });
  const failed = await session.run({ action: "check", scenario: scenario(`${own.origin}/`, "Pi-hole") });
  expect([passed.status, failed.status]).toEqual(["pass", "fail"]);
  // The AI stops its server and removes what started it.
  await services.stop(own.name);
  await rm(path.join(root, "own.ts"));
  services.ensureSlot("web", { command: command("Dashboard"), port: "auto", ready: { log: "listening" }, timeoutMs: 10_000 });
  await services.start("web", signal);
  session.invalidate();
  await session.replayStale(0);
  const report = await session.report();
  const stale = report.checks.find(check => check.id === passed.id)!;
  expect(stale).toMatchObject({ status: "incomplete", freshness: "stale",
    reason: expect.stringContaining(`the server it ran on (${own.origin}) is gone`), gone: own.origin });
  expect(stale.notes?.some(note => note.startsWith(`could not start ${own.name} again:`))).toBe(true);
  expect(report.checks.find(check => check.id === failed.id)).toMatchObject({ status: "fail", freshness: "fresh" });
  expect(report.status).toBe("fail");
  // Replayed again (the AI's repair turn), still on Casper's server: still stale, not a failure.
  expect(await session.run({ action: "replay", id: passed.id })).toMatchObject({ status: "incomplete", freshness: "stale", gone: own.origin });
}, 60_000);

browserTest("a check whose ad-hoc service Casper let go (more were started after it) replays on the same command, started again", async () => {
  const { services, session, command, signal, scenario } = await setup();
  const app = command("Weather 21°C");
  const own = await services.startCommand(app, { ready: { log: "listening" } }, signal);
  const recorded = await session.run({ action: "check", scenario: scenario(`${own.origin}/`, "Weather 21°C") });
  expect(recorded.status).toBe("pass");
  await services.stop(own.name);
  // Four more ad-hoc services: the oldest stopped slot, the check's own, is let go.
  for (const other of ["Stub one", "Stub two", "Stub three", "Stub four"]) {
    const started = await services.startCommand(command(other), { ready: { log: "listening" } }, signal);
    await services.stop(started.name);
  }
  expect(services.status().some(service => service.name === own.name)).toBe(false);
  session.invalidate();
  await session.replayStale(0);
  const replayed = (await session.report()).checks.find(check => check.id === recorded.id)!;
  expect(replayed).toMatchObject({ status: "pass", freshness: "fresh" });
  expect(replayed.notes?.some(note => /^started adhoc-\d+ again for this replay: it had stopped$/.test(note))).toBe(true);
  expect(services.status().filter(service => service.state === "ready")).toEqual([]);
}, 60_000);

browserTest("an end replay puts back the settings its check was recorded with and restarts the check's own server, which holds them in memory", async () => {
  const { project, services, session, command, signal, scenario } = await setup();
  await mkdir(path.join(project, "config"));
  await writeFile(path.join(project, "config/title.yaml"), "Empty dashboard\n");
  const own = await services.startCommand(command("", "caching.ts"), { ready: { log: "listening" } }, signal);
  const recorded = await session.run({ action: "check", scenario: scenario(`${own.origin}/`, "Empty dashboard") });
  expect(recorded.status).toBe("pass");
  // Later the AI's server holds other settings (a widget installed through the page), and is still running at the end.
  await writeFile(path.join(project, "config/title.yaml"), "Weather installed\n");
  await services.restart(own.name, signal);
  session.invalidate();
  await session.replayStale(0);
  const report = await session.report();
  expect(report.checks.find(check => check.id === recorded.id)).toMatchObject({ status: "pass", freshness: "fresh" });
  // The settings and the server come back as the AI left them.
  expect(await readFile(path.join(project, "config/title.yaml"), "utf8")).toBe("Weather installed\n");
  expect(await (await fetch(services.origin(own.name)!)).text()).toContain("Weather installed");
}, 60_000);

browserTest("a check that fails after Casper answered Cancel to a confirm dialog is not checked, not failed: Casper can't answer OK", async () => {
  const { session } = await setup();
  const page = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(`<!doctype html><button id="go" onclick="if (confirm('Clear the list?')) document.querySelector('h1').textContent = 'Cleared'">Clear list</button><h1>Two items</h1>`,
    { headers: { "content-type": "text/html; charset=utf-8" } }) });
  cleanup.push(() => page.stop(true));
  const url = `http://127.0.0.1:${page.port}/`;
  const clicked = (expected: string) => ({ name: `after the click: ${expected}`, url, steps: [{ action: "click", selector: "#go", impact: "local-test" }], assertions: [{ kind: "text", selector: "h1", expected }] });
  const needsOk = await session.run({ action: "check", scenario: clicked("Cleared") });
  // Read before toMatchObject, which leaves its matcher in the field it matched.
  const { id, reason } = needsOk as { id: string; reason: string };
  expect(needsOk).toMatchObject({ status: "incomplete", cancelled: "confirm", reason: expect.stringContaining('Casper answered Cancel, so this check can\'t see what OK does. On this computer\'s pages, record it again with dialog: "accept"') });
  expect(reason).toEndWith(`with dialog: "accept" on that step and replaces: "${id}".`);
  // A check that expects what Cancel does still passes.
  expect(await session.run({ action: "check", scenario: clicked("Two items") })).toMatchObject({ status: "pass" });
  const report = await session.report();
  expect(report.status).toBe("incomplete");
}, 45_000);

/** A page whose list has `items.count` rows and, while `items.button`, a #go button. */
function listPage() {
  const items = { count: 1, button: true };
  const page = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(`<!doctype html>${items.button ? `<button id="go" onclick="document.querySelector('h1').textContent = 'Opened'">Open</button>` : ""}<h1>List</h1><ul>${"<li class=\"row\">Row</li>".repeat(items.count)}</ul>`,
    { headers: { "content-type": "text/html; charset=utf-8" } }) });
  cleanup.push(() => page.stop(true));
  return { items, url: `http://127.0.0.1:${page.port}/` };
}

browserTest("an assertion whose selector matches several elements is a check written wrong: not recorded, and on a replay not a failure", async () => {
  const { session } = await setup();
  const { items, url } = listPage();
  items.count = 2;
  const row = { name: "one row", url, steps: [], assertions: [{ kind: "text", selector: "li.row", expected: "Row" }] };
  // As a step selector that matches several already is: nothing is recorded, and the AI is told to name one element.
  await expect(session.run({ action: "check", scenario: row })).rejects.toThrow(/assertion 1's selector matches 2 elements \(matches: li "Row" = li:nth-of-type\(1\); li "Row" = li:nth-of-type\(2\)\): name one element and record the check again \(nothing was recorded\)/);
  expect((await session.report()).checks).toEqual([]);
  // Recorded while it matched one; the page later has two: written wrong, not failed.
  items.count = 1;
  const recorded = await session.run({ action: "check", scenario: row });
  expect(recorded.status).toBe("pass");
  items.count = 2;
  session.invalidate();
  const replayed = await session.run({ action: "replay", id: recorded.id });
  expect(replayed).toMatchObject({ status: "incomplete", writtenWrong: "assertion 1's selector matches 2 elements", reason: expect.stringContaining("Written wrong") });
  expect((await session.report()).status).toBe("incomplete");
}, 45_000);

browserTest("an end replay that can't finish says why; it never keeps the earlier pass", async () => {
  const { session } = await setup();
  const { items, url } = listPage();
  const opened = await session.run({ action: "check", scenario: { name: "open", url, steps: [{ action: "click", selector: "#go", impact: "local-test" }], assertions: [{ kind: "text", selector: "h1", expected: "Opened" }] } });
  expect(opened.status).toBe("pass");
  items.button = false;
  session.invalidate();
  await session.replayStale(0);
  const check = (await session.report()).checks.find(entry => entry.id === opened.id)!;
  expect(check).toMatchObject({ status: "incomplete", notReplayed: expect.stringContaining("matches 0") });
  expect(check.freshness).not.toBe("stale");
}, 45_000);

browserTest("at the end, a check recorded while another of the AI's services answered it (its mock) replays with that service started again too", async () => {
  const { root, services, session, command, signal, scenario } = await setup();
  await writeFile(path.join(root, "mock.ts"), SERVER);
  const mock = await services.startCommand(command("ok", "mock.ts"), { ready: { log: "listening" } }, signal);
  const app = await services.startCommand(command(mock.origin!, "status.ts"), { ready: { log: "listening" } }, signal);
  const recorded = await session.run({ action: "check", scenario: scenario(`${app.origin}/`, "Up") });
  expect(recorded.status).toBe("pass");
  // The AI cleans up: both stopped.
  await services.stop(app.name); await services.stop(mock.name);
  session.invalidate();
  await session.replayStale(0);
  const replayed = (await session.report()).checks.find(check => check.id === recorded.id)!;
  expect(replayed).toMatchObject({ status: "pass", freshness: "fresh" });
  expect(replayed.notes).toEqual(expect.arrayContaining([`started ${mock.name} again for this replay: it had stopped`, `started ${app.name} again for this replay: it had stopped`]));
  // Left as the AI left them, and the mock kept its port (the app's settings name it).
  expect(services.status().filter(service => service.state === "ready")).toEqual([]);
  expect(services.status().find(service => service.name === mock.name)?.origin).toBeUndefined();
}, 60_000);

browserTest("a check whose other service can't start again is not replayed, not failed, and says which service", async () => {
  const { root, services, session, command, signal, scenario } = await setup();
  await writeFile(path.join(root, "mock.ts"), SERVER);
  const mock = await services.startCommand(command("ok", "mock.ts"), { ready: { log: "listening" } }, signal);
  const app = await services.startCommand(command(mock.origin!, "status.ts"), { ready: { log: "listening" } }, signal);
  const recorded = await session.run({ action: "check", scenario: scenario(`${app.origin}/`, "Up") });
  expect(recorded.status).toBe("pass");
  await services.stop(mock.name);
  await rm(path.join(root, "mock.ts"));
  session.invalidate();
  await session.replayStale(0);
  const replayed = (await session.report()).checks.find(check => check.id === recorded.id)!;
  expect(replayed).toMatchObject({ status: "incomplete", notReplayed: expect.stringMatching(new RegExp(`^it needs ${mock.name} \\(.*mock\\.ts.*\\), which could not start again: `)) });
}, 60_000);

browserTest("a step with dialog: accept answers OK to the confirm it opens, on a page on this computer; the next step's dialog is Cancel again", async () => {
  const { session } = await setup();
  const page = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(`<!doctype html><button id="go" onclick="document.querySelector('h1').textContent = confirm('Remove Weather?') ? 'Removed' : 'Kept'">Go</button><h1>Weather</h1>`,
    { headers: { "content-type": "text/html; charset=utf-8" } }) });
  cleanup.push(() => page.stop(true));
  const url = `http://127.0.0.1:${page.port}/`;
  const click = (dialog?: "accept") => ({ action: "click", selector: "#go", impact: "local-test", ...(dialog ? { dialog } : {}) });
  const accepted = await session.run({ action: "check", scenario: { name: "remove after OK", url, steps: [click("accept")], assertions: [{ kind: "text", selector: "h1", expected: "Removed" }] } });
  expect(accepted).toMatchObject({ status: "pass", notes: ['step 1: confirm dialog "Remove Weather?": Casper answered OK (dialog: accept)'] });
  // Only the step that asked: the next one's dialog is Cancel, as by default.
  const then = await session.run({ action: "check", scenario: { name: "OK then Cancel", url, steps: [click("accept"), click()], assertions: [{ kind: "text", selector: "h1", expected: "Kept" }] } });
  expect(then.status).toBe("pass");
  await expect(session.run({ action: "check", scenario: { name: "bad", url, steps: [{ ...click(), dialog: "yes" }], assertions: [{ kind: "text", selector: "h1", expected: "Kept" }] } }))
    .rejects.toThrow('Browser scenario step 1 dialog must be "accept"');
  await expect(session.run({ action: "check", scenario: { name: "remote", url: "https://example.invalid/", steps: [click("accept")], assertions: [{ kind: "text", selector: "h1", expected: "Kept" }] } }))
    .rejects.toThrow("dialog: accept works only on a page on this computer");
}, 45_000);

browserTest("a text assertion whose selector holds more than its expected text, failing since it was recorded, is written wrong: named, not failed", async () => {
  const { session } = await setup();
  const page = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(`<!doctype html><div class="tile"><span class="badge">S</span><span class="status">Up</span></div><h1>Home</h1>`,
    { headers: { "content-type": "text/html; charset=utf-8" } }) });
  cleanup.push(() => page.stop(true));
  const url = `http://127.0.0.1:${page.port}/`;
  // As a real run wrote it: the whole tile, which reads "SUp", for the status word "Up".
  const wide = await session.run({ action: "check", scenario: { name: "status word", url, steps: [], assertions: [{ kind: "text", selector: ".tile", expected: "Up" }] } });
  expect(wide).toMatchObject({ status: "incomplete", writtenWrong: "assertion 1's selector is wider than the element that reads its text" });
  session.invalidate();
  expect(await session.run({ action: "replay", id: wide.id })).toMatchObject({ status: "incomplete", writtenWrong: expect.stringContaining("wider") });
  // A wrong text with no element reading it is still a failure.
  const wrong = await session.run({ action: "check", scenario: { name: "wrong", url, steps: [], assertions: [{ kind: "text", selector: "h1", expected: "Away" }] } });
  expect(wrong.status).toBe("fail");
  expect((await session.report()).status).toBe("fail");
}, 45_000);

// A sign-up build: a check that registered an account was refused as written wrong ("nothing was recorded"), and the
// next one with the same email failed because the account was already there.
browserTest("a new check written wrong whose steps fill a fixed email says its steps ran and their data stays; one with {run} says nothing was recorded", async () => {
  const { session } = await setup();
  const page = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(`<!doctype html><input id="email"><button id="go">Join</button><ul><li class="row">Row</li><li class="row">Row</li></ul><input class="e"><input class="e"><button class="b">A</button><button class="b">B</button>`,
    { headers: { "content-type": "text/html; charset=utf-8" } }) });
  cleanup.push(() => page.stop(true));
  const signUp = (email: string) => ({ name: "sign up", url: `http://127.0.0.1:${page.port}/`,
    steps: [{ action: "fill", selector: "#email", value: email, impact: "local-test" }, { action: "click", selector: "#go", impact: "local-test" }],
    assertions: [{ kind: "text", selector: "li.row", expected: "Row" }] });
  const fixed = await session.run({ action: "check", scenario: signUp("new@example.com") }).catch((error: Error) => error.message);
  expect(fixed).toContain("name one element and record the check again (nothing was recorded, but its steps ran: what they saved, such as a sign-up, stays in the app; use {run} in fill values)");
  const fresh = await session.run({ action: "check", scenario: signUp("new-{run}@example.com") }).catch((error: Error) => error.message);
  expect(fresh).toEndWith("name one element and record the check again (nothing was recorded)");
  // A step refused for several matches: only the steps before it ran, and the fill itself refused ran nothing.
  const step = (steps: unknown[]) => session.run({ action: "check", scenario: { ...signUp("new@example.com"), steps, assertions: [{ kind: "visible", selector: "#go" }] } })
    .catch((error: Error) => error.message);
  const fill = { action: "fill", selector: "#email", value: "new@example.com", impact: "local-test" };
  expect(await step([fill, { action: "click", selector: "button.b", impact: "local-test" }])).toEndWith(
    "name one element and record the check again (nothing was recorded, but step 1 ran: what it saved, such as a sign-up, stays in the app; use {run} in fill values)");
  expect(await step([{ ...fill, selector: "input.e" }, { action: "click", selector: "#go", impact: "local-test" }])).toEndWith(
    "name one element and record the check again (nothing was recorded)");
  expect((await session.report()).checks).toEqual([]);
}, 45_000);
