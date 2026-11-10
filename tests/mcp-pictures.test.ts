import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { CasperApp } from "../src/app";
import { MAX_IMAGE_BYTES, MAX_IMAGES } from "../src/app/images";
import { CapabilityBroker } from "../src/capabilities/broker";
import { takePictures } from "../src/capabilities/pictures";
import { fitImage } from "../src/pictures/fit";
import { boundCapabilityResult } from "../src/capabilities/result";
import { loadConfiguration } from "../src/config/load";
import type { MCPServerDefinition } from "../src/mcp/config";
import { MCPManager } from "../src/mcp/manager";
import { loadProjectContext } from "../src/project/context";
import { toolContent } from "../src/runtime/pi";
import { FIXTURE_PIXEL } from "./fixtures/mcp-server";
import { withEnv } from "./support/env";
import { CHILD_KILL_MS, childTestLimit } from "./support/limits";
import { removeTempDir } from "./support/temp-dir";

/** Decision 99: an MCP picture reaches a model that can see images, inside the limits a request's pictures have. */

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const fixturePath = path.join(import.meta.dir, "fixtures/mcp-server.ts");
const OMITTED = "binary MCP content is not exposed";

async function pictureBroker(pictures?: () => boolean) {
  const definition: MCPServerDefinition = { name: "pics", source: "fixture", cwd: process.cwd(), disabled: false, transport: {
    type: "stdio", command: process.execPath, args: [fixturePath], env: { FIXTURE_MODE: "pictures", FIXTURE_ID: "pics" },
  } };
  const mcp = new MCPManager({ servers: [definition], diagnostics: [] }, { connectTimeoutMs: CHILD_KILL_MS, callTimeoutMs: 5000 });
  cleanup.push(() => mcp.close());
  await mcp.connect("pics");
  return new CapabilityBroker(mcp, undefined, pictures ? { pictures } : {});
}

/** A black RGB PNG: tiny in bytes, large in size. With `body`, that IDAT instead of the real pixels (a corrupt one). */
function blankPng(width: number, height: number, body?: Buffer): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const bytes = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(bytes.length + 8);
    out.writeUInt32BE(data.length, 0); bytes.copy(out, 4); out.writeUInt32BE(crc32(bytes), bytes.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const idat = body ?? deflateSync(Buffer.alloc((width * 3 + 1) * height), { level: 1 });
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

/** A JPEG that is only a header: SOI, a baseline SOF0 frame of that size, EOI. */
function jpegHeader(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0, 16, ...Buffer.from("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.from([0xff, 0xc0, 0, 17, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

/** A GIF that is only a header: its logical screen size, no frames. */
function gifHeader(width: number, height: number): Buffer {
  const out = Buffer.alloc(14);
  out.write("GIF89a", 0, "latin1"); out.writeUInt16LE(width, 6); out.writeUInt16LE(height, 8); out[13] = 0x3b;
  return out;
}

const CORRUPT = Buffer.from("not a zlib stream, so the picture can't be decoded");

const asIs = async (data: string, mimeType: string) => ({ image: { data, mimeType } });

test("an MCP picture reaches the AI's tool result after the text, with a line where it was; audio and blobs stay out", async () => {
  const broker = await pictureBroker();
  const call = (await broker.prepare("site map picture")).find((tool) => tool.name === "call_capability")!;
  const answer = await call.execute({ id: "mcp:pics:snapshot", arguments: {} });
  expect(answer.isError).toBe(false);
  expect(answer.images).toHaveLength(1);
  expect(answer.images![0]!.mimeType).toMatch(/^image\/(png|jpeg)$/);
  expect(answer.text).not.toContain(FIXTURE_PIXEL);
  const result = JSON.parse(answer.text);
  // The audio and the blob were left out; the picture was not.
  expect(result.summary).toBe("Partial result: binary content was left out. 1 picture follows this result.");
  expect(result.data.content).toEqual([
    { type: "text", text: "Site map" },
    { type: "image", mimeType: answer.images![0]!.mimeType, picture: 1 },
    { type: "audio", mimeType: "audio/wav", omitted: OMITTED },
    { type: "resource", resource: { uri: "fixture://map.bin", mimeType: "application/octet-stream" }, omitted: OMITTED },
  ]);
  // A model that can't see images gets the text and a note, never the picture.
  const blind = toolContent(answer, false);
  expect(blind).toEqual([{ type: "text", text: answer.text }, { type: "text", text: "Picture not attached: this model can't see images." }]);
  expect(JSON.stringify(blind)).not.toContain(answer.images![0]!.data);
  expect(toolContent(answer, true).at(-1)).toEqual({ type: "image", ...answer.images![0]! });
}, childTestLimit());

test("a model that can't see images gets today's note, and no picture is shrunk for it", async () => {
  const broker = await pictureBroker();
  const call = (await broker.prepare("site map picture")).find((tool) => tool.name === "call_capability")!;
  const answer = await call.execute({ id: "mcp:pics:snapshot", arguments: {} }, undefined, { withFileLocks: (_paths, work) => work(), seesImages: false });
  expect(answer.isError).toBe(false);
  expect(answer.images).toBeUndefined();
  const result = JSON.parse(answer.text);
  // Today's note in the picture's place: takePictures never ran, so nothing was shrunk.
  expect(result.summary).toBe("Partial result: binary content was left out.");
  expect(result.data.content[1]).toEqual({ type: "image", mimeType: "image/png", omitted: OMITTED });
  expect(answer.text).not.toContain(FIXTURE_PIXEL);
}, childTestLimit());

test("the pictures of one result shrink at the same time, in order", async () => {
  const started: number[] = [];
  const release: (() => void)[] = [];
  const fit = (data: string, mimeType: string) => {
    started.push(started.length);
    return new Promise<{ image: { data: string; mimeType: string } }>((resolve) => { release.push(() => resolve({ image: { data, mimeType } })); });
  };
  const pictures = Array.from({ length: 3 }, () => ({ type: "image", data: FIXTURE_PIXEL, mimeType: "image/png" }));
  const taking = takePictures({ content: pictures }, fit);
  // Every shrink starts before the first one ends.
  for (let tries = 0; started.length < 3 && tries < 100; tries++) await Bun.sleep(5);
  expect(started).toHaveLength(3);
  for (const done of release.reverse()) done();
  const taken = await taking;
  expect(taken.images).toHaveLength(3);
  expect((taken.value as { content: Record<string, unknown>[] }).content.map((line) => line.picture)).toEqual([1, 2, 3]);
});

test("Stop ends the wait for pictures: the result comes back with the pictures not yet shrunk left out", async () => {
  const stopped = new AbortController();
  stopped.abort();
  let asked = 0;
  const counting = async (data: string, mimeType: string) => { asked++; return { image: { data, mimeType } }; };
  const pictures = Array.from({ length: 3 }, () => ({ type: "image", data: FIXTURE_PIXEL, mimeType: "image/png" }));
  const already = await takePictures({ content: pictures }, counting, stopped.signal);
  expect(asked).toBe(0);
  expect(already.images).toEqual([]);
  expect((already.value as { content: unknown[] }).content).toEqual(Array(3).fill({ type: "image", mimeType: "image/png", omitted: "picture left out: stopped" }));

  // Stopped while shrinking: the wait ends without the shrink finishing.
  const during = new AbortController();
  const never = () => new Promise<{ image?: { data: string; mimeType: string } }>(() => {});
  const taking = takePictures({ content: [{ type: "text", text: "Map" }, ...pictures] }, never, during.signal);
  during.abort();
  const taken = await taking;
  expect(taken.images).toEqual([]);
  expect((taken.value as { content: unknown[] }).content).toEqual([{ type: "text", text: "Map" },
    ...Array(3).fill({ type: "image", mimeType: "image/png", omitted: "picture left out: stopped" })]);
});

test("an error result's picture, and the reader's own calls, keep today's note", async () => {
  const broker = await pictureBroker();
  const failed = await broker.answer("mcp:pics:snapshot_failed", {});
  expect(failed.isError).toBe(true);
  expect(failed.images).toBeUndefined();
  expect(JSON.parse(failed.text).data.content[1]).toEqual({ type: "image", mimeType: "image/png", omitted: OMITTED });
  const reader = await broker.invoke("mcp:pics:snapshot", {});
  expect(JSON.stringify(reader)).not.toContain(FIXTURE_PIXEL);
  expect((reader.data as { content: unknown[] }).content[1]).toEqual({ type: "image", mimeType: "image/png", omitted: OMITTED });
}, childTestLimit());

test("at most MAX_IMAGES pictures per result and MAX_IMAGE_BYTES each; one that can't be made small enough is left out", async () => {
  const pictures = Array.from({ length: MAX_IMAGES + 2 }, () => ({ type: "image", data: FIXTURE_PIXEL, mimeType: "image/png" }));
  const many = await takePictures({ content: pictures }, asIs);
  expect(many.images).toHaveLength(MAX_IMAGES);
  const lines = (many.value as { content: Record<string, unknown>[] }).content;
  expect(lines.slice(0, MAX_IMAGES).map((line) => line.picture)).toEqual(Array.from({ length: MAX_IMAGES }, (_, i) => i + 1));
  expect(lines.slice(MAX_IMAGES)).toEqual(Array(2).fill({ type: "image", mimeType: "image/png", omitted: `picture left out: at most ${MAX_IMAGES} per result` }));
  const bounded = boundCapabilityResult(many.value, 16_384, 50, { mcp: true });
  expect(bounded.summary).toBe("Partial result: binary content was left out.");
  expect(JSON.stringify(bounded)).not.toContain(FIXTURE_PIXEL);

  const huge = FIXTURE_PIXEL.slice(0, 24) + "A".repeat(Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 8);
  let asked = 0;
  const big = await takePictures({ content: [{ type: "image", data: huge, mimeType: "image/png" }] }, async () => { asked++; return {}; });
  expect(asked).toBe(0);
  expect(big).toEqual({ value: { content: [{ type: "image", mimeType: "image/png", omitted: `picture left out: over ${MAX_IMAGE_BYTES / 1024 / 1024} MB` }] }, images: [] });

  const tooLarge = await takePictures({ content: [{ type: "image", data: FIXTURE_PIXEL, mimeType: "image/png" }] }, async () => ({}));
  expect(tooLarge).toEqual({ value: { content: [{ type: "image", mimeType: "image/png",
    omitted: "picture left out: the tool's picture (1x1 px, 1 KB) was not sent: it could not be shrunk to 2000 px and 4.5 MB" }] }, images: [] });
});

test("a wide picture is shrunk to at most 2000 px, with a note that maps it back", async () => {
  const wide = await takePictures({ content: [{ type: "image", data: blankPng(3840, 2160).toString("base64"), mimeType: "image/png" }] });
  expect(wide.images).toHaveLength(1);
  expect((wide.value as { content: unknown[] }).content[0]).toMatchObject({ type: "image", picture: 1,
    note: "[Image: original 3840x2160, displayed at 2000x1125. Multiply coordinates by 1.92 to map to original image.]" });
}, 30_000);

test("a picture that can't be decoded is sent as it is only when its header says it is already within 2000 px", async () => {
  // A small file that says it is 3000 px wide, with a body Photon can't decode: never sent unshrunk.
  const wide = blankPng(3000, 10, CORRUPT).toString("base64");
  expect(await fitImage(wide, "image/png")).toEqual({});
  const taken = await takePictures({ content: [{ type: "image", data: wide, mimeType: "image/png" }] }, fitImage, undefined, "site_map");
  expect(taken.images).toEqual([]);
  expect((taken.value as { content: unknown[] }).content).toEqual([{ type: "image", mimeType: "image/png",
    omitted: "picture left out: site_map's picture (3000x10 px, 1 KB) was not sent: it could not be shrunk to 2000 px and 4.5 MB" }]);
  // One whose header says 100x100 is within the limit: it goes as it is (no image library here does the same).
  const small = blankPng(100, 100, CORRUPT).toString("base64");
  expect(await fitImage(small, "image/png")).toEqual({ image: { data: small, mimeType: "image/png" } });
}, 30_000);

test("a picture whose header says it is over 16384 px a side or 40 megapixels, or has no size, is never decoded", async () => {
  let asked = 0;
  const counting = async (data: string, mimeType: string) => { asked++; return { image: { data, mimeType } }; };
  const notOpened = (what: string) => `picture left out: site_map's picture (${what}) was not opened: over 16384 px a side or 40 megapixels`;
  const cases: [Buffer, string, string][] = [
    [blankPng(30_000, 10, CORRUPT), "image/png", notOpened("30000x10 px, 1 KB")],
    [blankPng(8000, 8000, CORRUPT), "image/png", notOpened("8000x8000 px, 1 KB")],
    [jpegHeader(20_000, 20_000), "image/jpeg", notOpened("20000x20000 px, 1 KB")],
    [jpegHeader(16_385, 100), "image/jpeg", notOpened("16385x100 px, 1 KB")],
    [gifHeader(65_535, 65_535), "image/gif", notOpened("65535x65535 px, 1 KB")],
    // A header cut short, or a JPEG with no frame: its size can't be read, so it is not opened either.
    [blankPng(100, 100).subarray(0, 20), "image/png", "picture left out: site_map's picture (1 KB) was not opened: its size could not be read"],
    [Buffer.from([0xff, 0xd8, 0xff, 0xd9]), "image/jpeg", "picture left out: site_map's picture (1 KB) was not opened: its size could not be read"],
  ];
  for (const [bytes, mimeType, omitted] of cases) {
    const taken = await takePictures({ content: [{ type: "image", data: bytes.toString("base64"), mimeType }] }, counting, undefined, "site_map");
    expect(taken).toEqual({ value: { content: [{ type: "image", mimeType, omitted }] }, images: [] });
  }
  expect(asked).toBe(0);
  // Within both limits: decoded and sent.
  for (const bytes of [jpegHeader(16_384, 2000), gifHeader(4000, 3000), blankPng(6000, 6000, CORRUPT)]) {
    expect((await takePictures({ content: [{ type: "image", data: bytes.toString("base64"), mimeType: "image/png" }] }, counting)).images).toHaveLength(1);
  }
  expect(asked).toBe(3);
});

test("audio, blobs, non-picture images and error results pass through untouched for today's note", async () => {
  const content = [
    { type: "audio", data: "UklGRgAAAABXQVZF", mimeType: "audio/wav" },
    { type: "resource", resource: { uri: "fixture://x", blob: "AAEC", mimeType: "application/octet-stream" } },
    { type: "image", data: Buffer.from("<svg/>").toString("base64"), mimeType: "image/svg+xml" },
  ];
  const value = { content };
  expect(await takePictures(value, asIs)).toEqual({ value, images: [] });
  const failed = { isError: true, content: [{ type: "image", data: FIXTURE_PIXEL, mimeType: "image/png" }] };
  expect(await takePictures(failed, asIs)).toEqual({ value: failed, images: [] });
  expect(boundCapabilityResult(value).data).toEqual({ content: [
    { type: "audio", mimeType: "audio/wav", omitted: OMITTED },
    { type: "resource", resource: { uri: "fixture://x", mimeType: "application/octet-stream" }, omitted: OMITTED },
    { type: "image", mimeType: "image/svg+xml", omitted: OMITTED },
  ] });
});

test("mcp_pictures off: every picture keeps today's note and none is shrunk; the switch is read at each call", async () => {
  let on = false;
  const broker = await pictureBroker(() => on);
  const call = (await broker.prepare("site map picture")).find((tool) => tool.name === "call_capability")!;
  const off = await call.execute({ id: "mcp:pics:snapshot", arguments: {} }, undefined, { withFileLocks: (_paths, work) => work(), seesImages: true });
  expect(off.isError).toBe(false);
  expect(off.images).toBeUndefined();
  const result = JSON.parse(off.text);
  // No "picture follows" line and today's note in the picture's place: takePictures never ran, so nothing was shrunk.
  expect(result.summary).toBe("Partial result: binary content was left out.");
  expect(result.data.content[1]).toEqual({ type: "image", mimeType: "image/png", omitted: OMITTED });
  expect(off.text).not.toContain(FIXTURE_PIXEL);
  // Turned on again in /settings: the next call sends the picture.
  on = true;
  const back = await call.execute({ id: "mcp:pics:snapshot", arguments: {} });
  expect(back.images).toHaveLength(1);
}, childTestLimit());

test("a session's own broker follows mcp_pictures in ~/.casper/config.yaml: off keeps today's note, unset sends the picture", async () => {
  for (const config of ["mcp_pictures: off\n", ""]) {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-mcp-pictures-app-")));
    cleanup.push(() => removeTempDir(root));
    const home = path.join(root, "home"), project = path.join(root, "project");
    await mkdir(path.join(home, ".casper"), { recursive: true });
    await mkdir(path.join(project, ".casper"), { recursive: true });
    await writeFile(path.join(home, ".casper/config.yaml"), config);
    const server: MCPServerDefinition = { name: "pics", source: "fixture", cwd: process.cwd(), disabled: false, transport: {
      type: "stdio", command: process.execPath, args: [fixturePath], env: { FIXTURE_MODE: "pictures", FIXTURE_ID: "pics" },
    } };
    // The broker is the one the session's workspace loading builds, with the switch read from the fixture home.
    const answer = await withEnv({ HOME: home, USERPROFILE: home }, async () => {
      const app = new CasperApp({
        output: { write: () => {} }, runtimeFactory: () => { throw new Error("No model expected"); }, sessionHomeDir: home,
        loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
        loadMCPConfiguration: async () => ({ servers: [server], diagnostics: [] }),
        loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
        loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
      });
      try {
        await app.start(project);
        expect(app.projectContext?.mcpPictures).toBe(config ? "off" : undefined);
        await app.mcp!.connect("pics");
        const call = (await app.broker!.prepare("site map picture")).find((tool) => tool.name === "call_capability")!;
        return await call.execute({ id: "mcp:pics:snapshot", arguments: {} }, undefined, { withFileLocks: (_paths, work) => work(), seesImages: true });
      } finally { await app.close(); }
    });
    expect(answer.isError).toBe(false);
    expect(answer.text).not.toContain(FIXTURE_PIXEL);
    const result = JSON.parse(answer.text);
    if (config) {
      expect(answer.images).toBeUndefined();
      expect(result.summary).toBe("Partial result: binary content was left out.");
      expect(result.data.content[1]).toEqual({ type: "image", mimeType: "image/png", omitted: OMITTED });
    } else {
      expect(answer.images).toHaveLength(1);
      expect(result.summary).toBe("Partial result: binary content was left out. 1 picture follows this result.");
      expect(result.data.content[1]).toEqual({ type: "image", mimeType: answer.images![0]!.mimeType, picture: 1 });
    }
  }
}, childTestLimit(2));

test("mcp_pictures is read from the user file only, on by default, rejects other values and is refused in a project or profile", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-mcp-pictures-"));
  cleanup.push(() => removeTempDir(root));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  await mkdir(path.join(home, ".casper/profiles/default"), { recursive: true });
  await mkdir(path.join(project, ".casper"), { recursive: true });
  const load = () => loadConfiguration({ projectRoot: project, homeDir: home });
  expect((await load()).mcpPictures).toBeUndefined();
  for (const [text, value] of [["off", "off"], ["false", "off"], ["on", "on"], ["true", "on"]] as const) {
    await writeFile(path.join(home, ".casper/config.yaml"), `mcp_pictures: ${text}\n`);
    expect((await load()).mcpPictures).toBe(value);
  }
  await writeFile(path.join(home, ".casper/config.yaml"), "mcp_pictures: sometimes\n");
  await expect(load()).rejects.toThrow("mcp_pictures must be");
  await writeFile(path.join(home, ".casper/config.yaml"), "");
  await writeFile(path.join(project, ".casper/project.yaml"), "mcp_pictures: off\n");
  await expect(load()).rejects.toThrow("mcp_pictures is a user setting");
  await writeFile(path.join(project, ".casper/project.yaml"), "");
  await writeFile(path.join(home, ".casper/profiles/default/config.yaml"), "mcp_pictures: off\n");
  await expect(load()).rejects.toThrow("mcp_pictures is set in ~/.casper/config.yaml only");
});

test("a picture's type comes from its bytes, not the mimeType the server declared", async () => {
  const mislabeled = await takePictures({ content: [{ type: "image", data: FIXTURE_PIXEL, mimeType: "image/jpeg" }] }, asIs);
  expect(mislabeled.images).toEqual([{ data: FIXTURE_PIXEL, mimeType: "image/png" }]);
  expect((mislabeled.value as { content: unknown[] }).content).toEqual([{ type: "image", mimeType: "image/png", picture: 1 }]);
  // Text that calls itself a PNG is not sent as a picture.
  const fake = { content: [{ type: "image", data: Buffer.from("<svg/>").toString("base64"), mimeType: "image/png" }] };
  expect(await takePictures(fake, asIs)).toEqual({ value: fake, images: [] });
});
