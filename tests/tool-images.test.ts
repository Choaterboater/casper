import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { fitPicture } from "../src/browser/tools";
import { isolatedEnvironment } from "../src/platform/environment";
import { toolContent } from "../src/runtime/pi";
import { removeTempDir } from "./support/temp-dir";

/** A picture in one of Casper's tool results goes to a model that can see images, after the text; another model gets
 * the text and a note that the picture was left out. */

const roots: string[] = [];
const servers: Array<{ stop(force: boolean): void }> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const root of roots.splice(0)) await removeTempDir(root);
});
const repo = path.resolve(import.meta.dir, "..");
// A 1x1 PNG, base64: a marker the provider request either carries or not.
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function chunk(delta: unknown, finish: string | null): string {
  return `data: ${JSON.stringify({ id: "images", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}
const sse = (body: string) => new Response(body + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
const snapCall = () => sse(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_0", type: "function", function: { name: "snap", arguments: "{}" } }] }, null) + chunk({}, "tool_calls"));

/** One prompt against a real PiRuntime in a child process: the model calls `snap`, whose result carries a picture. */
async function run(input: string[]): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-tool-images-"))); roots.push(root);
  const home = path.join(root, "home"), project = path.join(root, "project"), agent = path.join(home, ".pi/agent");
  await mkdir(agent, { recursive: true }); await mkdir(project); await mkdir(path.join(home, ".casper"));
  const payloads: unknown[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    payloads.push(await request.json());
    return payloads.length === 1 ? snapCall() : sse(chunk({ role: "assistant", content: "DONE" }, "stop"));
  } });
  servers.push(server);
  await writeFile(path.join(agent, "models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "local-fixture-not-a-secret", models: [{ id: "fixture", input }] } } }));
  const routing = { defaultProvider: "fixture", defaultModel: "fixture" };
  await writeFile(path.join(agent, "settings.json"), JSON.stringify({ ...routing, retry: { enabled: false } }));
  await writeFile(path.join(home, ".casper/settings.json"), JSON.stringify(routing));
  const env = { ...isolatedEnvironment(home), TMPDIR: root, PI_CODING_AGENT_DIR: agent, CASPER_AGENT_DIR: agent, CASPER_OFFLINE: "1", PI_OFFLINE: "1", PI_TELEMETRY: "0" };
  const tool = `{ name: "snap", description: "Take a picture.", inputSchema: { type: "object", properties: {} },
    execute: async () => ({ text: "SNAP_TEXT", images: [{ data: ${JSON.stringify(PIXEL)}, mimeType: "image/png" }] }) }`;
  const child = Bun.spawn([process.execPath, "-e", `import { PiRuntime } from ${JSON.stringify(path.join(repo, "src/runtime/pi.ts"))};
    const runtime = new PiRuntime(); const session = await runtime.start({ cwd: process.cwd(), localModels: false, tools: [${tool}] });
    try { await session.prompt("Take a picture"); } finally { await runtime.dispose(); }`], { cwd: project, env, stdout: "pipe", stderr: "pipe" });
  const [stderr, exit] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  expect(payloads).toHaveLength(2);
  return JSON.stringify(payloads[1]);
}

test("toolContent: text first, then the pictures for a model that sees images; otherwise the text and a note", () => {
  const image = { data: PIXEL, mimeType: "image/png" };
  expect(toolContent({ text: "plain" }, true)).toEqual([{ type: "text", text: "plain" }]);
  expect(toolContent({ text: "plain" }, false)).toEqual([{ type: "text", text: "plain" }]);
  expect(toolContent({ text: "shot", images: [image] }, true)).toEqual([{ type: "text", text: "shot" }, { type: "image", ...image }]);
  expect(toolContent({ text: "shot", images: [image] }, false)).toEqual([{ type: "text", text: "shot" },
    { type: "text", text: "Picture not attached: this model can't see images." }]);
});

test("a model that can see images gets the tool's picture with its text", async () => {
  const request = await run(["text", "image"]);
  expect(request).toContain("SNAP_TEXT");
  expect(request).toContain(PIXEL);
  expect(request).not.toContain("Picture not attached");
}, 90_000);

test("a model that can't see images gets the tool's text and a note, never the picture", async () => {
  const request = await run(["text"]);
  expect(request).toContain("SNAP_TEXT");
  expect(request).not.toContain(PIXEL);
  expect(request).toContain("Picture not attached: this model can't see images.");
}, 90_000);

/** An RGB PNG of random pixels, which no encoder can shrink much. */
function noisyPng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let i = 0; i < rows.length; i++) rows[i] = i % (width * 3 + 1) === 0 ? 0 : Math.floor(Math.random() * 256);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows, { level: 1 })), chunk("IEND", Buffer.alloc(0))]);
}

test("a screenshot too big for the provider is shrunk below 4.5 MB of base64 first, as Pi's read tool does", async () => {
  const big = noisyPng(1920, 1080).toString("base64");
  expect(big.length).toBeGreaterThan(5 * 1024 * 1024);
  const fitted = await fitPicture(big);
  expect(fitted.image!.data.length).toBeLessThan(4.5 * 1024 * 1024);
  const small = noisyPng(40, 20).toString("base64");
  expect(await fitPicture(small)).toEqual({ image: { data: small, mimeType: "image/png" }, note: undefined });
}, 30_000);
