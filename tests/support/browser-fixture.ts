import { afterEach, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BrowserSession } from "../../src/browser/session";
import { removeTempDir } from "./temp-dir";

// The local page, its server and the browser session the phase10-browser files test against (they were one file
// until it outgrew a 300 s run on macOS).
export const executable = process.env.CASPER_BROWSER_EXECUTABLE ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const browserTest = existsSync(executable) ? test : test.skip;
/** A loopback port nothing listens on just now. */
export const freePort = async () => { const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") }); const port = probe.port; await probe.stop(true); return port; };

/** One test file's fixtures: whatever a test opened (servers, sessions, folders) is closed after it, last first. */
export function browserFixtures() {
  const cleanup: Array<() => Promise<unknown>> = [];
  afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
  async function fixture(options: { executablePath?: string; firstStartMs?: number; actionTimeoutMs?: number; confirm?: (request: unknown, signal: AbortSignal) => Promise<boolean>; navigationTimeoutMs?: number; allowActions?: () => boolean; checkPictures?: () => boolean; savePictures?: boolean } = {}) {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-browser-test-")));
    cleanup.push(() => removeTempDir(root));
    const project = path.join(root, "project"), state = path.join(root, "state");
    await mkdir(project); await mkdir(state);
    const sourceFile = path.join(project, "index.html");
    const images: string[] = [];
    const streams: Array<{ path: string; started: number; cancelled?: number }> = [];
    await writeFile(sourceFile, '<!doctype html><title>Browser fixture</title><h1>Hello Casper</h1><button>Save</button><script>console.error("synthetic-console-error");fetch("/missing-api")</script>');
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(request) {
      if (new URL(request.url).pathname === "/hang") return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("<html>")); } }), { headers: { "content-type": "text/html" } });
      if (new URL(request.url).pathname === "/missing-api") return new Response("fixture failure", { status: 503 });
      if (new URL(request.url).pathname === "/gone.svg") return new Response("gone", { status: 404 });
      // A picture file with no length that keeps coming (or stops halfway): reading it must stop on its own.
      // (The image itself loads, so the page does.)
      if (new URL(request.url).pathname.startsWith("/stream-") && request.headers.get("sec-fetch-dest") !== "image") {
        const entry: (typeof streams)[number] = { path: new URL(request.url).pathname, started: Date.now() };
        streams.push(entry);
        const chunk = new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg">${"<!-- padding -->".repeat(4000)}`);
        const endless = entry.path.includes("endless");
        return new Response(new ReadableStream({
          async pull(controller) { if (endless) { controller.enqueue(chunk); await new Promise(resolve => setTimeout(resolve, 5)); } else { controller.enqueue(chunk); await new Promise(() => {}); } },
          cancel() { entry.cancelled = Date.now(); },
        }), { headers: { "content-type": "image/svg+xml" } });
      }
      // A picture that arrives late, after the words around it are on screen.
      if (new URL(request.url).pathname.startsWith("/late-")) await Bun.sleep(700);
      if (new URL(request.url).pathname.endsWith(".svg")) {
        // Only what the page loads as an image counts, not the look check's own read of the file.
        if (request.headers.get("sec-fetch-dest") === "image") images.push(new URL(request.url).pathname);
        // A drawing the test wrote into the project, else a plain square.
        const drawn = path.join(project, path.basename(new URL(request.url).pathname));
        return new Response(existsSync(drawn) ? await readFile(drawn) : '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>', { headers: { "content-type": "image/svg+xml" } });
      }
      return new Response(await readFile(sourceFile), { headers: { "content-type": "text/html", "cache-control": "no-store" } });
    } });
    cleanup.push(async () => { server.stop(true); });
    const session = new BrowserSession({ projectRoot: project, stateDirectory: state, executablePath: executable, ...options });
    cleanup.push(() => session.close());
    return { root, project, sourceFile, state, session, images, streams, url: `http://127.0.0.1:${server.port}` };
  }
  return { cleanup, fixture };
}
