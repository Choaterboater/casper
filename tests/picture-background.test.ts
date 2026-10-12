import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CasperApp } from "../src/app";
import { PendingPictures } from "../src/pictures/pending";
import { BACKGROUND_NOTE, FREE_PICTURE_MODEL, pictureTool } from "../src/pictures/tool";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeSession, RuntimeStartOptions } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { removeTempDir } from "./support/temp-dir";

/** make_picture in the background: the call returns the path at once, and what would touch the file waits for it.
 * A fake image service (Bun.serve) answers only when the test lets it. */

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

async function folder(): Promise<string> {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-picture-bg-")));
  cleanups.push(() => removeTempDir(base));
  return base;
}

/** An image service that holds every request until `answer()`, which lets through the ones waiting (or, with none
 * waiting yet, the next one to arrive); `status` other than 200 fails it. */
function slowImages(status = 200) {
  const models: string[] = [];
  let open = 0, most = 0, permits = 0;
  const waiting: Array<() => void> = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const body = await request.json() as { model: string };
    models.push(body.model);
    most = Math.max(most, ++open);
    if (permits) permits--; else await new Promise<void>((resolve) => waiting.push(resolve));
    open--;
    if (status !== 200) return Response.json({ error: { message: "nope" } }, { status });
    return Response.json({ data: [{ b64_json: PNG.toString("base64") }], usage: { total_tokens: 10, cost: 0 } });
  } });
  const answer = () => { if (waiting.length) for (const release of waiting.splice(0)) release(); else permits++; };
  cleanups.push(() => { for (const release of waiting.splice(0)) release(); server.stop(true); });
  const origin = `http://127.0.0.1:${server.port}`;
  return { models, most: () => most, answer, urls: { openrouter: `${origin}/api/v1/images`, openai: `${origin}/v1/images/generations` } };
}

function tool(root: string, urls: { openrouter: string; openai: string }, background: PendingPictures, request = "") {
  return pictureTool({ root: () => root, request: () => request, secrets: () => [], record: () => {}, background,
    sources: { codex: async () => undefined, key: async (provider) => provider === "openrouter" ? "or-key-fake" : undefined, models: [], urls } });
}

const exists = (file: string) => stat(file).then(() => true, () => false);
/** Whether `work` is still waiting after a short while. */
const stillWaiting = (work: Promise<unknown>) => Promise.race([work.then(() => false), Bun.sleep(150).then(() => true)]);

test("the call returns the path before the service answers; a read of that path waits and then sees the file", async () => {
  const images = slowImages();
  const root = await folder();
  const pending = new PendingPictures();
  const made = await tool(root, images.urls, pending).execute({ prompt: "a red bicycle", path: "assets/bike.png" });
  expect(JSON.parse(made.text)).toEqual({ saving: "assets/bike.png", note: BACKGROUND_NOTE });
  expect(made.isError).toBeUndefined();
  expect(await exists(path.join(root, "assets", "bike.png"))).toBe(false);
  const read = pending.before("read", { path: "assets/bike.png" }, root);
  expect(await stillWaiting(read)).toBe(true);
  images.answer();
  expect(await read).toEqual([]);
  expect(await readFile(path.join(root, "assets", "bike.png"))).toEqual(PNG);
  expect(pending.size).toBe(0);
});

test("a read, edit or write of another file and grep do not wait; a shell command, a listing and the browser do", async () => {
  const images = slowImages();
  const root = await folder();
  const pending = new PendingPictures();
  await tool(root, images.urls, pending).execute({ prompt: "a lighthouse", path: "img/lighthouse.png" });
  expect(await pending.before("read", { path: "index.html" }, root)).toEqual([]);
  expect(await pending.before("edit", { path: "img/other.png" }, root)).toEqual([]);
  expect(await pending.before("grep", { pattern: "lighthouse" }, root)).toEqual([]);
  // A build copying the folder, a listing of it or a page may all see it before the picture is there.
  const build = pending.before("bash", { command: "npm run build" }, root);
  const listing = pending.before("ls", { path: "img" }, root);
  const browser = pending.before("browser", { action: "open", url: "http://127.0.0.1:3000" }, root);
  for (const call of [build, listing, browser]) expect(await stillWaiting(call)).toBe(true);
  images.answer();
  expect(await Promise.all([build, listing, browser])).toEqual([[], [], []]);
  expect(await exists(path.join(root, "img", "lighthouse.png"))).toBe(true);
});

test("a wait cut short by Esc leaves the failure for the next call, and a new conversation is not told the old one's", async () => {
  const images = slowImages(429);
  const root = await folder();
  const pending = new PendingPictures();
  await tool(root, images.urls, pending).execute({ prompt: "a harbour", path: "harbour.png" });
  const esc = new AbortController();
  const read = pending.before("read", { path: "harbour.png" }, root, esc.signal);
  esc.abort();
  expect(await read).toEqual([]);
  images.answer();
  expect(await pending.settle()).toEqual([expect.stringMatching(/^picture harbour\.png failed: /)]);
  pending.forget();
  expect(await pending.before("bash", { command: "ls" }, root)).toEqual([]);
});

test("a failure reaches the call that waited; one nobody waited for comes with the next tool result, once", async () => {
  const images = slowImages(429);
  const root = await folder();
  const pending = new PendingPictures();
  await tool(root, images.urls, pending).execute({ prompt: "a mountain lake", path: "lake.png" });
  const read = pending.before("read", { path: "lake.png" }, root);
  images.answer();
  const [failure] = await read;
  expect(failure).toStartWith(`picture lake.png failed: No picture was made (${FREE_PICTURE_MODEL}: `);
  expect(failure).toEndWith("Draw the art as inline SVG instead.");
  expect(await pending.before("bash", { command: "ls" }, root)).toEqual([]);

  await tool(root, images.urls, pending).execute({ prompt: "a forest", path: "forest.png" });
  images.answer();
  // The end of the task waits for it, says it once, and the model still gets it once.
  expect(await pending.settle()).toEqual([expect.stringMatching(/^picture forest\.png failed: /)]);
  expect(await pending.settle()).toEqual([]);
  expect(await pending.before("bash", { command: "ls" }, root)).toEqual([expect.stringMatching(/^picture forest\.png failed: /)]);
  expect(await pending.before("bash", { command: "ls" }, root)).toEqual([]);
});

test("at most 3 pictures are made at once; the 4th queues, and the paid guard still refuses a model the user never named", async () => {
  const images = slowImages();
  const root = await folder();
  const pending = new PendingPictures();
  const picture = tool(root, images.urls, pending, "build a landing page with a hero picture");
  const results = [];
  for (const name of ["a", "b", "c", "d"]) results.push(JSON.parse((await picture.execute({ prompt: `picture ${name}`, path: `${name}.png`, model: "black-forest-labs/flux-3-image" })).text));
  expect(results[0]).toEqual({ saving: "a.png", note: BACKGROUND_NOTE, model: expect.stringContaining("a paid model runs only when the user names it") });
  await Bun.sleep(100);
  expect(images.models).toEqual([FREE_PICTURE_MODEL, FREE_PICTURE_MODEL, FREE_PICTURE_MODEL]);
  const settled = pending.settle();
  images.answer();
  await Bun.sleep(100);
  images.answer();
  expect(await settled).toEqual([]);
  expect(images.most()).toBe(3);
  expect(images.models).toEqual(Array(4).fill(FREE_PICTURE_MODEL));
  for (const name of ["a", "b", "c", "d"]) expect(await exists(path.join(root, `${name}.png`))).toBe(true);
});

/** A runtime whose model calls make_picture, then reads the file through Casper's own wait, and ends its turn. */
class PictureRuntime implements AgentRuntime {
  seen: { readBefore?: boolean; readAfter?: boolean; notes?: string[] } = {};
  constructor(private readonly root: () => string, private readonly onPicture: () => void) {}
  async start(options: RuntimeStartOptions): Promise<RuntimeSession> {
    const tools = () => options.tools ?? [];
    let current = tools();
    return {
      prompt: async () => {
        const picture = current.find((tool) => tool.name === "make_picture");
        if (!picture) return;
        await picture.execute({ prompt: "a bakery storefront", path: "assets/hero.png" });
        this.seen.readBefore = await exists(path.join(this.root(), "assets", "hero.png"));
        const wait = options.beforeToolNotes!("read", { path: "assets/hero.png" });
        this.onPicture();
        this.seen.notes = await wait;
        this.seen.readAfter = await exists(path.join(this.root(), "assets", "hero.png"));
        // A second picture the model never touches: the service answers well after the model's turn ends.
        await picture.execute({ prompt: "a loaf of bread", path: "assets/bread.png" });
        setTimeout(() => this.onPicture(), 1000);
      },
      setTools: (next) => { current = next; }, abort: async () => {}, subscribe: () => () => {},
      signedIn: (provider) => provider === "openrouter", providerKey: async (provider) => provider === "openrouter" ? "or-key-fake" : undefined,
      getState: () => ({ cwd: options.cwd, isStreaming: false }),
    };
  }
  async dispose() {}
}

test("Casper's own wait before a tool call finishes the picture, and the end of the task waits for every pending one", async () => {
  const images = slowImages();
  const base = await folder();
  const home = path.join(base, "home"), project = path.join(base, "project");
  await mkdir(path.join(home, ".casper", "agent"), { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(path.join(home, ".casper", "config.yaml"), "");
  await writeFile(path.join(home, ".casper", "agent", "auth.json"), JSON.stringify({ openrouter: { type: "api_key", key: "or-key-fake" } }));
  let answered = 0;
  const runtime = new PictureRuntime(() => project, () => { answered++; images.answer(); });
  const casper = new CasperApp({
    runtimeFactory: () => runtime, output: { write: () => {} }, sessionHomeDir: home, verificationMode: "off",
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
    pictureSeams: { env: { PATH: "" }, urls: images.urls },
  });
  cleanups.push(() => casper.close());
  await casper.start(project);
  await casper.runOnce("Build a landing page for a bakery with photos");
  expect(answered).toBe(2);
  expect(runtime.seen).toEqual({ readBefore: false, notes: [], readAfter: true });
  expect(await exists(path.join(project, "assets", "bread.png"))).toBe(true);
  expect(casper.pendingPictures.size).toBe(0);
});
