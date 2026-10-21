import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BrowserSession, browserEnvironment } from "../src/browser/session";
import { discoverBrowser } from "../src/browser/discovery";
import { withEnv } from "./support/env";
import { removeTempDir } from "./support/temp-dir";

// The installed browser wherever it is (phase10-browser looks only where macOS keeps Chrome), so this runs on
// Windows and Linux runners too.
const executable = await discoverBrowser(process.env.CASPER_BROWSER_EXECUTABLE);
const browserTest = executable ? test : test.skip;
// Named steps: in the full suite on Linux and Windows this test has hung in cleanup for 90 s with no step named
// (tests/known-flaky.ts). A step that doesn't finish in 20 s now fails with its name, and the others still run.
const cleanup: Array<[string, () => Promise<unknown>]> = [];
afterEach(async () => {
  const stuck: string[] = [];
  for (const [name, close] of cleanup.splice(0).reverse()) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => { timer = setTimeout(() => resolve("late"), 20_000); });
    try { if (await Promise.race([close(), late]) === "late") stuck.push(name); }
    finally { clearTimeout(timer); }
  }
  if (stuck.length) throw new Error(`cleanup did not finish in 20 s: ${stuck.join(", ")}`);
}, 70_000);

/** The user's real folder from Windows itself: the suite's preload moved USERPROFILE to a test home, and Chrome hangs on
 * any USERPROFILE but the real one. Casper itself runs with the real one, as here. */
function realUserFolder(): string | undefined {
  if (process.platform !== "win32") return undefined;
  const result = Bun.spawnSync(["powershell", "-NoProfile", "-Command", "[Environment]::GetFolderPath('UserProfile')"], { stdout: "pipe", stderr: "pipe" });
  return result.stdout.toString().trim() || undefined;
}

test("Chrome gets no secrets and a home in its own profile, but keeps USERPROFILE on Windows", () => {
  const env = { USERPROFILE: "C:\\Users\\fixture", OPENROUTER_API_KEY: "fixture-secret", DISPLAY: ":9" };
  const windows = browserEnvironment("C:\\Temp\\casper-browser-x", "win32", env);
  expect(windows.USERPROFILE).toBe("C:\\Users\\fixture");
  expect(windows.HOME).toBe("C:\\Temp\\casper-browser-x");
  expect(windows.DISPLAY).toBe(":9");
  expect(JSON.stringify(windows)).not.toContain("fixture-secret");
  const posix = browserEnvironment("/tmp/casper-browser-x", "linux", env);
  expect(posix.HOME).toBe("/tmp/casper-browser-x");
  expect(posix.USERPROFILE).not.toBe("C:\\Users\\fixture");
  expect(JSON.stringify(posix)).not.toContain("fixture-secret");
});

browserTest("the installed browser starts, opens a local page and closes", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-browser-start-")));
  cleanup.push(["temp folder", () => removeTempDir(root)]);
  const project = path.join(root, "project"), state = path.join(root, "state");
  await mkdir(project); await mkdir(state);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<!doctype html><title>Start fixture</title><h1>Hello Casper</h1>", { headers: { "content-type": "text/html" } }) });
  cleanup.push(["page server", () => server.stop(true)]);
  // This test is about Chrome starting, not the open's 15 s: in the loaded Windows suite the first open after a cold
  // start has run past 15 s with Chrome up (a 17.7 s failure), so it gets 30 s.
  const session = new BrowserSession({ projectRoot: project, stateDirectory: state, executablePath: executable, actionTimeoutMs: 30_000 });
  cleanup.push(["browser", () => session.close()]);
  const folder = realUserFolder();
  const opened = await withEnv(folder ? { USERPROFILE: folder } : {}, () => session.run({ action: "open", url: `http://127.0.0.1:${server.port}/` }));
  expect(JSON.stringify(opened)).toContain("Start fixture");
  await session.close();
}, 60_000);
