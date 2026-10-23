import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SteerWaits } from "../src/app/steer-waits";
import { discoverBrowser } from "../src/browser/discovery";
import { BrowserSession, screenAvailable, type BrowserSessionOptions } from "../src/browser/session";
import { removeTempDir } from "./support/temp-dir";

/**
 * A Home Assistant build: Casper's browser is headless with its own profile, so the AI could never see a page behind
 * a login, and the model offered a "sign in to Casper's browser" that didn't exist. signin opens a window on the
 * session's profile for the person to sign in; the next page the AI opens is signed in. Tests keep that window
 * headless (signInHeadless), so CI never shows one.
 */
const executable = await discoverBrowser(process.env.CASPER_BROWSER_EXECUTABLE);
const browserTest = executable && process.platform !== "win32" ? test : test.skip;
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(options: Partial<BrowserSessionOptions> = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-signin-")));
  cleanup.push(() => removeTempDir(root));
  const project = path.join(root, "project"), state = path.join(root, "state");
  await mkdir(project); await mkdir(state);
  // The site's own sign-in: /login sets a lasting cookie; / says whether the browser has it.
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/login") return new Response("<!doctype html><title>Sign in</title>", { headers: { "content-type": "text/html", "set-cookie": "session=ok; Max-Age=3600; Path=/" } });
    const signedIn = (request.headers.get("cookie") ?? "").includes("session=ok");
    return new Response(`<!doctype html><title>${signedIn ? "signed in" : "signed out"}</title>`, { headers: { "content-type": "text/html" } });
  } });
  cleanup.push(async () => { server.stop(true); });
  const base = `http://127.0.0.1:${server.port}`;
  const notices: string[] = [];
  const session = new BrowserSession({ projectRoot: project, stateDirectory: state, executablePath: executable, signInHeadless: true, hasScreen: () => true,
    signInNotice: (message, done) => { notices.push(message); done(); }, ...options });
  cleanup.push(() => session.close());
  return { session, base, notices };
}

test("a window can be shown on macOS and Windows, and on Linux only with a display", () => {
  expect(screenAvailable("darwin", {})).toBe(true);
  expect(screenAvailable("win32", {})).toBe(true);
  expect(screenAvailable("linux", {})).toBe(false);
  expect(screenAvailable("linux", { DISPLAY: ":0" })).toBe(true);
  expect(screenAvailable("linux", { WAYLAND_DISPLAY: "wayland-0" })).toBe(true);
});

browserTest("a run that can't ask, or a computer with no screen, gets a plain refusal and no window", async () => {
  const none = await fixture();
  await expect(none.session.run({ action: "signin", url: `${none.base}/login` })).rejects.toThrow("this run can't ask you");
  const unanswered = await fixture({ confirmSignIn: async () => undefined });
  await expect(unanswered.session.run({ action: "signin", url: `${unanswered.base}/login` })).rejects.toThrow("this run can't ask you");
  const headless = await fixture({ confirmSignIn: async () => true, hasScreen: () => false });
  await expect(headless.session.run({ action: "signin", url: `${headless.base}/login` })).rejects.toThrow("no screen for a sign-in window");
  expect([none.notices, unanswered.notices, headless.notices]).toEqual([[], [], []]);
}, 30_000);

browserTest("No opens no window and the AI's pages stay signed out", async () => {
  const asked: string[] = [];
  const f = await fixture({ confirmSignIn: async ({ origin }) => { asked.push(origin); return false; } });
  expect(await f.session.run({ action: "signin", url: `${f.base}/login` })).toMatchObject({ signedIn: "cancelled" });
  expect(asked).toEqual([f.base]);
  expect(f.notices).toEqual([]);
  expect(await f.session.run({ action: "open", url: `${f.base}/` })).toMatchObject({ title: "signed out" });
}, 30_000);

browserTest("Yes: the person signs in in the window, and the next page the AI opens uses that sign-in", async () => {
  const f = await fixture({ confirmSignIn: async () => true });
  // A headless Chrome is already running: it gives the profile up for the window and the next start takes it back.
  expect(await f.session.run({ action: "open", url: `${f.base}/` })).toMatchObject({ title: "signed out" });
  const result = await f.session.run({ action: "signin", url: `${f.base}/login` });
  expect(result).toMatchObject({ signedIn: "window closed", url: `${f.base}/login` });
  expect(JSON.stringify(result)).not.toContain("session=ok");
  expect(f.notices).toEqual([expect.stringContaining("Sign in there, then close the window")]);
  expect(await f.session.run({ action: "open", url: `${f.base}/` })).toMatchObject({ title: "signed in" });
}, 45_000);

browserTest("the action's own time waits for the person, and a window left open times out", async () => {
  let person: Promise<void> | undefined;
  const slow = await fixture({ confirmSignIn: async () => true, actionTimeoutMs: 1_000,
    signInNotice: (_message, done) => { person = new Promise(resolve => setTimeout(() => { done(); resolve(); }, 1_500)); } });
  expect(await slow.session.run({ action: "signin", url: `${slow.base}/login` })).toMatchObject({ signedIn: "window closed" });
  await person;
  const left = await fixture({ confirmSignIn: async () => true, signInTimeoutMs: 300, signInNotice: () => {} });
  expect(await left.session.run({ action: "signin", url: `${left.base}/login` })).toMatchObject({ signedIn: "timed out" });
}, 45_000);

browserTest("a line the person sends the AI while the window is open ends the wait as closing it does: the sign-in is kept and the AI hears they wrote", async () => {
  const waits = new SteerWaits();
  const f = await fixture({ confirmSignIn: async () => true, whenSteered: waits.listen, signInNotice: () => {} });
  const signin = f.session.run({ action: "signin", url: `${f.base}/login` });
  let told = 0;
  for (let i = 0; i < 300 && !told; i++) { told = waits.steered(); if (!told) await Bun.sleep(50); }
  expect(told).toBe(1);
  const result = await signin;
  expect(result).toMatchObject({ signedIn: "person wrote", url: `${f.base}/login`,
    guidance: "The person sent you a message while the sign-in window was open, so it was closed; a sign-in they finished there is kept. Read the message first. Open the page again to check you are signed in. The sign-in lasts until this browser session closes." });
  expect(await f.session.run({ action: "open", url: `${f.base}/` })).toMatchObject({ title: "signed in" });
  // A window closed the usual way stops listening too: a later line ends nothing.
  const closed = await fixture({ confirmSignIn: async () => true, whenSteered: waits.listen });
  expect(await closed.session.run({ action: "signin", url: `${closed.base}/login` })).toMatchObject({ signedIn: "window closed" });
  expect(waits.steered()).toBe(0);
}, 60_000);
