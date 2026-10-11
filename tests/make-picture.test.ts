import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CasperApp } from "../src/app";
import { assembleTaskTools, picturesRequested } from "../src/app/capabilities";
import { settingRows } from "../src/app/settings";
import { loadConfiguration } from "../src/config/load";
import { FREE_PICTURE_MODEL, pictureTool, type PictureSources } from "../src/pictures/tool";
import { codexEnvironment } from "../src/pictures/codex";
import { pictureSize, webSize, type ShrinkOptions } from "../src/pictures/shrink";
import { loadProjectContext } from "../src/project/context";
import { inspectProject } from "../src/project/inspect";
import type { AgentRuntime, RuntimeSession, RuntimeStartOptions, RuntimeTool } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { FULL_HELP_TEXT } from "../src/tui/help";
import { removeTempDir } from "./support/temp-dir";

/** make_picture with a fake codex first on PATH and fake image services (Bun.serve): no real codex, OpenRouter or
 * OpenAI call is ever made. */

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const posix = process.platform !== "win32";

async function folder(): Promise<string> {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-make-picture-")));
  cleanups.push(() => removeTempDir(base));
  return base;
}

/** A PNG header that says it is width x height, padded to `bytes`. */
function bigPng(width: number, height: number, bytes = 64): Buffer {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 0, 0, 0, 0, 0, 8, 6, 0, 0, 0]);
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return Buffer.concat([header, Buffer.alloc(Math.max(0, bytes - header.length))]);
}
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const SESSION = "00000000-0000-7000-8000-000000000001";

/** A fake codex: `login status` prints what `login` holds; `exec` logs its arguments and, when `mode` is ok, does what
 * Codex's image tool does: saves `picture` under $CODEX_HOME/generated_images/<session>/ and replies DONE. With none
 * it replies DONE and saves nothing; with fail it prints a failed turn. */
async function fakeCodex(base: string, options: { login?: string; mode?: "ok" | "fail" | "none"; picture?: Uint8Array } = {}) {
  const bin = path.join(base, "bin");
  await mkdir(bin, { recursive: true });
  const calls = path.join(base, "codex-calls.txt");
  const home = path.join(base, "codex-home");
  await writeFile(path.join(base, "login"), options.login ?? "Logged in using ChatGPT\n");
  await writeFile(path.join(base, "mode"), options.mode ?? "ok");
  await writeFile(path.join(base, "picture.bin"), options.picture ?? PNG);
  await writeFile(path.join(bin, "codex"), `#!/bin/sh
if [ "$1" = login ]; then echo status >> "${base}/logins"; cat "${base}/login"; exit 0; fi
for arg in "$@"; do printf '%s\\n' "$arg" >> "${calls}"; done
printf '%s\\n' "--end--" >> "${calls}"
echo '{"type":"thread.started","thread_id":"${SESSION}"}'
mode=$(cat "${base}/mode")
if [ "$mode" = ok ]; then
  mkdir -p "$CODEX_HOME/generated_images/${SESSION}"
  cp "${base}/picture.bin" "$CODEX_HOME/generated_images/${SESSION}/exec-new.png"
fi
if [ "$mode" != fail ]; then
  echo '{"type":"item.completed","item":{"type":"agent_message","text":"DONE"}}'
  echo '{"type":"turn.completed"}'
else
  echo '{"type":"turn.failed","error":{"message":"You have hit your usage limit."}}'
  exit 1
fi
`);
  await chmod(path.join(bin, "codex"), 0o755);
  return { home, env: { PATH: `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`, HOME: base, CODEX_HOME: home, OPENAI_API_KEY: "sk-should-never-reach-codex-0123456789" } as NodeJS.ProcessEnv,
    calls: async () => (await readFile(calls, "utf8").catch(() => "")).split("--end--\n").filter(Boolean).map((call) => call.trim().split("\n")) };
}

/** Fake OpenRouter and OpenAI image endpoints: each model answers as `answers` says (default: a PNG at $0). */
function fakeImages(answers: Record<string, { status: number; cost?: number; body?: unknown }> = {}) {
  const requests: Array<{ path: string; auth: string | null; body: { model: string; prompt: string; n: number; output_format: string } }> = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const body = await request.json() as (typeof requests)[number]["body"];
    requests.push({ path: new URL(request.url).pathname, auth: request.headers.get("authorization"), body });
    const answer = answers[body.model] ?? { status: 200, cost: 0 };
    if (answer.status !== 200) return Response.json(answer.body ?? { error: { message: "nope" } }, { status: answer.status });
    return Response.json({ data: [{ b64_json: PNG.toString("base64") }], usage: { total_tokens: 1200, ...(answer.cost !== undefined ? { cost: answer.cost } : {}) } });
  } });
  cleanups.push(() => server.stop(true));
  const origin = `http://127.0.0.1:${server.port}`;
  return { requests, urls: { openrouter: `${origin}/api/v1/images`, openai: `${origin}/v1/images/generations` } };
}

/** A fake sips or magick that records its arguments and writes `writes` to its output (the last argument, or the one
 * after --out). */
async function fakeShrinker(base: string, name: "sips" | "magick", writes: Uint8Array) {
  const bin = path.join(base, `${name}-bin`);
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(base, `${name}-out.bin`), writes);
  await writeFile(path.join(bin, name), `#!/bin/sh
printf '%s\\n' "$@" > "${base}/${name}-args.txt"
for arg in "$@"; do out="$arg"; done
/bin/cp "${base}/${name}-out.bin" "$out"
`);
  await chmod(path.join(bin, name), 0o755);
  return { file: path.join(bin, name), bin, args: async () => (await readFile(path.join(base, `${name}-args.txt`), "utf8").catch(() => "")).split("\n").filter(Boolean) };
}

function tool(root: string, sources: Partial<PictureSources> & Pick<PictureSources, "urls">, record: Array<unknown> = [], shrink?: ShrinkOptions) {
  return pictureTool({
    root: () => root, secrets: () => ["casper-own-secret-value-123"], record: (usage) => record.push(usage), ...(shrink ? { shrink } : {}),
    sources: { codex: async () => undefined, key: async (provider) => provider === "openrouter" ? "or-key-fake" : undefined, models: [], ...sources },
  });
}

const parse = (result: { text: string }) => JSON.parse(result.text) as Record<string, unknown>;

test.skipIf(!posix)("Codex signed in with a ChatGPT plan makes the picture: saved in the project at $0, no OpenRouter call, no keys passed to Codex", async () => {
  const base = await folder();
  const codex = await fakeCodex(base);
  const images = fakeImages();
  const root = path.join(base, "project");
  await mkdir(root);
  const record: unknown[] = [];
  const { codexSignedIn, findCodex } = await import("../src/pictures/codex");
  const file = findCodex(codex.env)!;
  expect(await codexSignedIn(file, { env: codex.env })).toBe(true);
  const made = await tool(root, { urls: images.urls, codex: async () => file, codexOptions: { env: codex.env } }, record)
    .execute({ prompt: "a red bicycle against a white wall", path: "assets/bike.png" });
  expect(parse(made)).toEqual({ saved: "assets/bike.png", bytes: PNG.length, source: "ChatGPT plan (Codex)", cost: "$0.00" });
  expect(new Uint8Array(await readFile(path.join(root, "assets", "bike.png")))).toEqual(new Uint8Array(PNG));
  expect(images.requests).toEqual([]);
  expect(record).toEqual([{ tokens: 0, estimatedCost: 0 }]);
  const [args] = await codex.calls();
  expect(args!.slice(0, 10)).toEqual(["exec", "--json", "--ephemeral", "--skip-git-repo-check", "-C", expect.any(String), "--enable", "image_generation", "-s", "read-only"]);
  // Codex's image tool saves the picture itself: Codex is told only to make it, never to write it out.
  const instructions = args!.slice(10).join("\n");
  expect(instructions).toContain("built-in image_gen tool to generate exactly one image of: a red bicycle against a white wall");
  expect(instructions).toContain("Do not save, copy, decode or write the image yourself, and do not run shell commands. Reply only DONE");
  // Codex keeps its own copy.
  expect(await readdir(path.join(codex.home, "generated_images", SESSION))).toEqual(["exec-new.png"]);
  // Codex gets where it lives and how to reach the network, never a key.
  expect(codexEnvironment(codex.env)).toEqual({ PATH: codex.env.PATH!, HOME: base, CODEX_HOME: codex.home });
});

test.skipIf(!posix)("Codex signed in with an API key is not used (it would cost money); a failed Codex turn falls through to the free model", async () => {
  const base = await folder();
  const apiKey = await fakeCodex(base, { login: "Logged in using an API key - sk-***\n" });
  const { codexSignedIn, findCodex } = await import("../src/pictures/codex");
  expect(await codexSignedIn(findCodex(apiKey.env)!, { env: apiKey.env })).toBe(false);

  const failing = await fakeCodex(await folder(), { mode: "fail" });
  const images = fakeImages();
  const root = await folder();
  const made = await tool(root, { urls: images.urls, codex: async () => findCodex(failing.env), codexOptions: { env: failing.env } })
    .execute({ prompt: "a lighthouse at dusk", path: "img/lighthouse.png" });
  expect(parse(made)).toMatchObject({ saved: "img/lighthouse.png", source: `OpenRouter ${FREE_PICTURE_MODEL}`, cost: "$0.00" });
  expect(await failing.calls()).toHaveLength(1);
  expect(images.requests.map((request) => request.body)).toEqual([{ model: FREE_PICTURE_MODEL, prompt: "a lighthouse at dusk", n: 1, output_format: "png" }]);
  expect(images.requests[0]!.auth).toBe("Bearer or-key-fake");
  expect(images.requests[0]!.path).toBe("/api/v1/images");
});

test("no paid call ever happens on its own: the free model limited and no Codex means no picture, and the model is told to draw SVG", async () => {
  for (const status of [402, 429, 500]) {
    const images = fakeImages({ [FREE_PICTURE_MODEL]: { status } });
    const root = await folder();
    const record: unknown[] = [];
    const made = await tool(root, { urls: images.urls }, record).execute({ prompt: "a mountain lake", path: "a.png" });
    expect(made.isError).toBe(true);
    expect(parse(made).error).toStartWith(`No picture was made (${FREE_PICTURE_MODEL}: `);
    expect(parse(made).next).toBe("Draw the art as inline SVG instead.");
    expect(images.requests.map((request) => request.body.model)).toEqual([FREE_PICTURE_MODEL]);
    expect(record).toEqual([]);
  }
  // Signed in nowhere: nothing is sent at all.
  const images = fakeImages();
  const made = await tool(await folder(), { urls: images.urls, key: async () => undefined }).execute({ prompt: "a mountain lake" });
  expect(parse(made).error).toContain("needs an OpenRouter sign-in");
  expect(images.requests).toEqual([]);
});

test("a model the request names is the only one tried, its cost is recorded, and a failure never moves on to another paid model", async () => {
  const images = fakeImages({ "black-forest-labs/flux-3-image": { status: 200, cost: 0.04 } });
  const root = await folder();
  const record: unknown[] = [];
  let codexAsked = false;
  const sources = { urls: images.urls, codex: async () => { codexAsked = true; return undefined; }, models: ["some/paid-model"] };
  const made = await tool(root, sources, record).execute({ prompt: "a fox", path: "fox.webp", model: "black-forest-labs/flux-3-image" });
  // The service sent a PNG: the file is named for what it is.
  expect(parse(made)).toEqual({ saved: "fox.png", bytes: PNG.length, source: "OpenRouter black-forest-labs/flux-3-image", cost: "$0.04" });
  expect(record).toEqual([{ tokens: 1200, estimatedCost: 0.04 }]);
  expect(codexAsked).toBe(false);
  expect(images.requests.map((request) => request.body)).toEqual([{ model: "black-forest-labs/flux-3-image", prompt: "a fox", n: 1, output_format: "webp" }]);

  const failing = fakeImages({ "black-forest-labs/flux-3-image": { status: 402 } });
  const failed = await tool(root, { ...sources, urls: failing.urls }).execute({ prompt: "a fox", model: "black-forest-labs/flux-3-image" });
  expect(parse(failed).next).toBe("Tell the user why; do not try another paid model unless they ask.");
  expect(failing.requests.map((request) => request.body.model)).toEqual(["black-forest-labs/flux-3-image"]);
});

test("your own pictures.models are tried in order after Codex, in place of the free model; a gpt-image model uses your OpenAI key", async () => {
  const images = fakeImages({ "first/model": { status: 429 }, "gpt-image-1-mini": { status: 200 } });
  const root = await folder();
  const record: unknown[] = [];
  const made = await tool(root, { urls: images.urls, models: ["first/model", "gpt-image-1-mini"], key: async (provider) => provider === "openai" ? "oa-key-fake" : "or-key-fake" }, record)
    .execute({ prompt: "a teapot", path: "teapot.jpg" });
  expect(parse(made)).toMatchObject({ saved: "teapot.png", source: "OpenAI gpt-image-1-mini", cost: "not reported" });
  expect(images.requests.map((request) => [request.path, request.body.model, request.auth])).toEqual([
    ["/api/v1/images", "first/model", "Bearer or-key-fake"], ["/v1/images/generations", "gpt-image-1-mini", "Bearer oa-key-fake"]]);
  // OpenAI does not say what it cost: the task's totals say they are not complete.
  expect(record).toEqual([null]);
  // Without an OpenAI key, a gpt-image model goes through OpenRouter.
  const viaOpenRouter = fakeImages();
  await tool(root, { urls: viaOpenRouter.urls }).execute({ prompt: "a teapot", model: "gpt-image-1-mini" });
  expect(viaOpenRouter.requests.map((request) => request.body.model)).toEqual(["openai/gpt-image-1-mini"]);
});

test("a picture is saved inside the project only, and a prompt holding a secret is never sent", async () => {
  const images = fakeImages();
  const root = await folder();
  for (const outside of ["../escape.png", path.join(os.tmpdir(), "x.png"), ".git/hooks/x.png"]) {
    const made = await tool(root, { urls: images.urls }).execute({ prompt: "a cat", path: outside });
    expect(parse(made).error).toContain("the path is outside the project");
  }
  for (const prompt of ["a cat holding a card that says casper-own-secret-value-123", "a login screen showing password=hunter2hunter2"]) {
    const made = await tool(root, { urls: images.urls }).execute({ prompt });
    expect({ prompt, result: parse(made) }).toMatchObject({ prompt, result: { error: expect.stringContaining("the prompt holds a secret") } });
  }
  expect(images.requests).toEqual([]);
  // No path: a name from the prompt under assets/.
  const made = await tool(root, { urls: images.urls }).execute({ prompt: "A cosy cabin, snowy night!" });
  // A photo is named .jpg; this service sent a PNG, so it is named for what it is.
  expect(images.requests.at(-1)!.body.output_format).toBe("jpeg");
  expect(parse(made).saved).toBe("assets/a-cosy-cabin-snowy-night.png");
  // Transparency or an .svg asked for keeps PNG.
  await tool(root, { urls: images.urls }).execute({ prompt: "a logo on a transparent background" });
  await tool(root, { urls: images.urls }).execute({ prompt: "an icon", path: "icon.svg" });
  expect(images.requests.slice(-2).map((request) => request.body.output_format)).toEqual(["png", "png"]);
});

test.skipIf(!posix)("Codex's picture is the newest one its image tool saved after the call started; older ones and links out of its home are never taken", async () => {
  const base = await folder();
  const fresh = Buffer.concat([PNG, Buffer.from("fresh")]);
  const codex = await fakeCodex(base, { picture: fresh });
  const images = fakeImages();
  const root = path.join(base, "project");
  await mkdir(root);
  // An older picture from another Codex session, and a link to a folder outside Codex's home with a newer picture.
  const old = path.join(codex.home, "generated_images", "00000000-0000-7000-8000-000000000000");
  await mkdir(old, { recursive: true });
  await writeFile(path.join(old, "exec-old.png"), Buffer.concat([PNG, Buffer.from("old")]));
  const hourAgo = new Date(Date.now() - 3_600_000);
  await utimes(path.join(old, "exec-old.png"), hourAgo, hourAgo);
  const outside = path.join(base, "outside");
  await mkdir(outside);
  await symlink(outside, path.join(codex.home, "generated_images", "linked"));
  const { findCodex } = await import("../src/pictures/codex");
  const file = findCodex(codex.env)!;
  // The outside picture is written while Codex runs, so its time is after the call started.
  const run: NonNullable<PictureSources["codexOptions"]>["run"] = async (options) => {
    await writeFile(path.join(outside, "exec-outside.png"), Buffer.concat([PNG, Buffer.from("outside")]));
    const { runCodex } = await import("../src/security/spawn");
    return runCodex(options);
  };
  const made = await tool(root, { urls: images.urls, codex: async () => file, codexOptions: { env: codex.env, run } })
    .execute({ prompt: "a harbour at dawn", path: "assets/harbour.png" });
  expect(parse(made)).toMatchObject({ saved: "assets/harbour.png", source: "ChatGPT plan (Codex)" });
  expect(await readFile(path.join(root, "assets", "harbour.png"))).toEqual(fresh);
  expect(images.requests).toEqual([]);
});

test.skipIf(!posix)("Codex that saves no new picture falls through to the next source, even with older pictures in its home", async () => {
  const base = await folder();
  const codex = await fakeCodex(base, { mode: "none" });
  const old = path.join(codex.home, "generated_images", SESSION);
  await mkdir(old, { recursive: true });
  await writeFile(path.join(old, "exec-old.png"), PNG);
  const hourAgo = new Date(Date.now() - 3_600_000);
  await utimes(path.join(old, "exec-old.png"), hourAgo, hourAgo);
  const images = fakeImages();
  const { findCodex } = await import("../src/pictures/codex");
  const made = await tool(await folder(), { urls: images.urls, codex: async () => findCodex(codex.env), codexOptions: { env: codex.env } })
    .execute({ prompt: "a lighthouse", path: "lighthouse.png" });
  expect(parse(made)).toMatchObject({ saved: "lighthouse.png", source: `OpenRouter ${FREE_PICTURE_MODEL}` });
  expect(await codex.calls()).toHaveLength(1);
  expect(images.requests).toHaveLength(1);
});

test.skipIf(!posix)("a picture over web size is shrunk: macOS's sips makes a 1600 px JPEG of a photo, saved as .jpg", async () => {
  const base = await folder();
  const codex = await fakeCodex(base, { picture: bigPng(3000, 2000) });
  const sips = await fakeShrinker(base, "sips", JPEG);
  const root = path.join(base, "project");
  await mkdir(root);
  const { findCodex } = await import("../src/pictures/codex");
  const made = await tool(root, { urls: fakeImages().urls, codex: async () => findCodex(codex.env), codexOptions: { env: codex.env } }, [],
    { platform: "darwin", sips: sips.file, env: { PATH: path.join(base, "empty") } })
    .execute({ prompt: "A mountain cabin at sunset" });
  expect(parse(made)).toEqual({ saved: "assets/a-mountain-cabin-at-sunset.jpg", bytes: JPEG.length, source: "ChatGPT plan (Codex)", cost: "$0.00" });
  expect(await readFile(path.join(root, "assets", "a-mountain-cabin-at-sunset.jpg"))).toEqual(JPEG);
  const args = await sips.args();
  expect(args.slice(0, 8)).toEqual(["-Z", "1600", "-s", "format", "jpeg", "-s", "formatOptions", "82"]);
  expect(args[9]).toBe("--out");
  expect(path.basename(args[10]!)).toBe("web.jpg");
});

test.skipIf(!posix)("without sips, ImageMagick on PATH shrinks it (a .png asked for stays PNG); with neither the picture is kept and the result says so", async () => {
  const base = await folder();
  const big = bigPng(1200, 900, 500 * 1024);
  const magick = await fakeShrinker(base, "magick", bigPng(1200, 900));
  const shrunk = await webSize(big, true, { platform: "linux", env: { PATH: magick.bin } });
  expect(shrunk).toEqual({ bytes: new Uint8Array(bigPng(1200, 900)) });
  const args = await magick.args();
  expect(args.slice(1, 3)).toEqual(["-resize", "1600x1600>"]);
  expect(path.basename(args[3]!)).toBe("web.png");
  // A photo becomes a JPEG at quality 82.
  await writeFile(path.join(base, "magick-out.bin"), JPEG);
  expect((await webSize(big, false, { platform: "linux", env: { PATH: magick.bin } })).bytes).toEqual(new Uint8Array(JPEG));
  expect((await magick.args()).slice(1)).toEqual(["-resize", "1600x1600>", "-background", "white", "-flatten", "-quality", "82", expect.stringMatching(/web\.jpg$/)]);
  // Small enough: nothing runs.
  expect(await webSize(PNG, false, { platform: "linux", env: { PATH: magick.bin } })).toEqual({ bytes: PNG });

  const root = await folder();
  const images = fakeImages();
  const codex = await fakeCodex(await folder(), { picture: bigPng(3000, 2000) });
  const { findCodex } = await import("../src/pictures/codex");
  const made = await tool(root, { urls: images.urls, codex: async () => findCodex(codex.env), codexOptions: { env: codex.env } }, [],
    { platform: "linux", env: { PATH: path.join(base, "empty") } }).execute({ prompt: "a field", path: "field.jpg" });
  expect(parse(made)).toMatchObject({ saved: "field.png", note: "kept at full size (3000x2000, 0 KB): no sips or ImageMagick here to shrink it" });
  expect(pictureSize(bigPng(3000, 2000))).toEqual({ width: 3000, height: 2000 });
});

test("make_picture is offered for picture and web-page requests when something can make one, and pictures: off takes it away", async () => {
  expect(picturesRequested("Build a landing page for my bakery with photos")).toBe(true);
  for (const task of ["Make a website for a cafe", "create a portfolio site", "add a hero image", "a logo for the app"]) expect({ task, offered: picturesRequested(task) }).toEqual({ task, offered: true });
  // A page task with no picture in it and nothing to build leaves it out: its text would stay for the session.
  for (const task of ["Add a sum function to src/math.ts", "check the website layout", "fix the hero section padding", "why is the webpage slow"]) expect({ task, offered: picturesRequested(task) }).toEqual({ task, offered: false });
  const picture = { name: "make_picture" } as RuntimeTool;
  const source = (task: string, offered = new Set<string>()) => assembleTaskTools(task, {
    broker: { prepare: async () => [] } as never, delegate: { name: "delegate" } as RuntimeTool, ask: { name: "ask" } as RuntimeTool,
    lsp: { status: () => [] } as never, confirmRename: async () => false, references: { tools: () => [] } as never, visualization: {} as never,
    projectRoot: "/", browserReady: false, browser: () => { throw new Error("no"); }, browserOff: true,
    services: { declared: false, live: false }, serviceTool: () => { throw new Error("no"); }, picture, offered });
  expect((await source("Make a website for a cafe")).map((tool) => tool.name)).toContain("make_picture");
  expect((await source("Add a sum function")).map((tool) => tool.name)).not.toContain("make_picture");
  expect((await source("Add a sum function", new Set(["make_picture"]))).map((tool) => tool.name)).toContain("make_picture");

  // Codex counts only when `codex login status` says ChatGPT (checked once per session); an API-key or no sign-in
  // with no OpenRouter sign-in offers nothing, so a tool that always fails never costs its text.
  for (const [config, codex, openrouter, offered] of [
    ["", "chatgpt", false, true], ["", "api key", false, false], ["", "none", false, false], ["", "none", true, true],
    ["pictures: off\n", "chatgpt", true, false], ["pictures:\n  enabled: false\n  models: [black-forest-labs/flux-3-image]\n", "chatgpt", true, false],
  ] as const) {
    if (!posix && codex !== "none") continue;
    const run = await app(config, { codex, openrouter });
    expect({ config, codex, openrouter, offered: run.names().includes("make_picture") }).toEqual({ config, codex, openrouter, offered });
  }
});

test.skipIf(!posix)("a task with no picture in it never runs codex; the first picture task checks its sign-in once", async () => {
  const run = await app("", { codex: "chatgpt", openrouter: false }, ["fix the parser", "check the website layout"]);
  expect(run.names()).not.toContain("make_picture");
  expect(await run.logins()).toBe(0);
  const later = await app("", { codex: "chatgpt", openrouter: false }, ["fix the parser", "Make a website with photos", "add a gallery"]);
  expect(later.names()).toContain("make_picture");
  expect(await later.logins()).toBe(1);
});

test("pictures: is your own setting: on/off and a models list; a project file can't set it; /settings and the long help name it", async () => {
  const base = await folder();
  const home = path.join(base, "home"), project = path.join(base, "project");
  await mkdir(path.join(home, ".casper"), { recursive: true });
  await mkdir(path.join(project, ".casper"), { recursive: true });
  await writeFile(path.join(home, ".casper", "config.yaml"), "pictures:\n  models: [black-forest-labs/flux-3-image, inclusionai/ming-image-0.1-design]\n");
  const loaded = await loadConfiguration({ projectRoot: project, homeDir: home });
  expect(loaded.pictureModels).toEqual(["black-forest-labs/flux-3-image", "inclusionai/ming-image-0.1-design"]);
  expect(loaded.pictures).toBeUndefined();
  expect(loaded.warnings).toEqual([]);
  await writeFile(path.join(home, ".casper", "config.yaml"), "pictures:\n  models: [\"not a model\"]\n");
  await expect(loadConfiguration({ projectRoot: project, homeDir: home })).rejects.toThrow("pictures.models must be a list of model ids");
  await writeFile(path.join(home, ".casper", "config.yaml"), "");
  await writeFile(path.join(project, ".casper", "project.yaml"), "pictures: on\n");
  await expect(loadConfiguration({ projectRoot: project, homeDir: home })).rejects.toThrow("pictures is a user setting");
  await writeFile(path.join(project, ".casper", "project.yaml"), "");
  const row = settingRows(await loadProjectContext(await inspectProject(project), { homeDir: home })).find((entry) => entry.label === "Pictures the AI makes")!;
  expect(row.value).toBe("on");
  expect(FULL_HELP_TEXT).toContain("pictures the AI makes");
});

class CaptureRuntime implements AgentRuntime {
  tools: RuntimeTool[] = [];
  constructor(private readonly openrouter: boolean) {}
  async start(options: RuntimeStartOptions): Promise<RuntimeSession> {
    this.tools = options.tools ?? [];
    return { prompt: async () => {}, setTools: (tools) => { this.tools = tools; }, abort: async () => {}, subscribe: () => () => {},
      signedIn: (provider) => this.openrouter && provider === "openrouter", providerKey: async () => undefined,
      getState: () => ({ cwd: options.cwd, isStreaming: false }) };
  }
  async dispose() {}
}

async function app(config: string, options: { codex: "chatgpt" | "api key" | "none"; openrouter: boolean },
  tasks = ["Build a landing page for a bakery with photos"]) {
  const base = await folder();
  const home = path.join(base, "home"), project = path.join(base, "project");
  await mkdir(path.join(home, ".casper"), { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(path.join(home, ".casper", "config.yaml"), config);
  // Before the first task starts the runtime, a saved OpenRouter sign-in is what counts.
  if (options.openrouter) {
    await mkdir(path.join(home, ".casper", "agent"), { recursive: true });
    await writeFile(path.join(home, ".casper", "agent", "auth.json"), JSON.stringify({ openrouter: { type: "api_key", key: "or-key-fake" } }));
  }
  // A fake codex whose `login status` says ChatGPT or an API key; with none, nothing is on PATH.
  const env = options.codex === "none" ? { PATH: "" }
    : (await fakeCodex(base, { login: options.codex === "chatgpt" ? "Logged in using ChatGPT\n" : "Logged in using an API key - sk-***\n" })).env;
  const runtime = new CaptureRuntime(options.openrouter);
  const casper = new CasperApp({
    runtimeFactory: () => runtime, output: { write: () => {} }, sessionHomeDir: home, verificationMode: "off",
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
    pictureSeams: { env },
  });
  cleanups.push(() => casper.close());
  await casper.start(project);
  for (const task of tasks) await casper.runOnce(task);
  return {
    names: () => runtime.tools.map((tool) => tool.name),
    logins: async () => (await readFile(path.join(base, "logins"), "utf8").catch(() => "")).split("\n").filter(Boolean).length,
  };
}
