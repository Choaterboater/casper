import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, realpath, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateRawSync, gzipSync } from "node:zlib";
import { EMBED_PLATFORMS, embedRipgrep, tarMember, zipMember } from "../scripts/embed-ripgrep";
import { TARGETS } from "../scripts/build-release";
import { embeddedRipgrepPath, embeddedSource, extractEmbeddedRipgrep } from "../src/security/ripgrep-embedded";
import { ensureRipgrep, resetRipgrep } from "../src/security/ripgrep";
import { pinnedRipgrepPath, RIPGREP, RIPGREP_BINARY_SHA256 } from "../src/security/ripgrep-pin";
import type { PinnedSpec } from "../src/security/tools";
import { removeTempDir } from "./support/temp-dir";

/** The ripgrep inside the release program: no real network and no real compile here; the "embedded" file is a stub. */

const roots: string[] = [];
let base = "";
let home = "";
let empty = "";
beforeEach(async () => {
  resetRipgrep();
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-rg-embed-")));
  roots.push(base);
  home = path.join(base, "home"); empty = path.join(base, "empty-path");
  await mkdir(home); await mkdir(empty);
});
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => removeTempDir(root))); resetRipgrep(); });

const GOOD = new TextEncoder().encode("#!/bin/sh\necho ripgrep 15.2.0\n");
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const posix = process.platform !== "win32";

/** The stub "embedded" file, and pins that accept it for every computer. */
async function embeddedFile(bytes: Uint8Array = GOOD): Promise<() => Promise<string>> {
  const file = path.join(base, "embedded-rg");
  await writeFile(file, bytes);
  return async () => file;
}
const PINS = Object.fromEntries(Object.keys(RIPGREP_BINARY_SHA256).map((key) => [key, digest(GOOD)]));

function stubSpec(): PinnedSpec {
  const asset = { url: "https://example.invalid/rg", sha256: digest(GOOD), archive: "raw", member: "rg" } as const;
  return { ...RIPGREP, source: { kind: "binary", assets: { "linux-x64": asset, "linux-arm64": asset, "darwin-x64": asset, "darwin-arm64": asset, "win32-x64": asset, "win32-arm64": asset } } };
}

async function run(extra: Record<string, unknown> = {}, embedded: (() => Promise<string | undefined>) | undefined = undefined) {
  const urls: string[] = [];
  const lines: string[] = [];
  const result = await ensureRipgrep({
    homeDir: home, env: { PATH: empty } as NodeJS.ProcessEnv, spec: stubSpec(), platform: "linux", arch: "x64",
    embedded: { ...(embedded ? { source: embedded } : { source: async () => undefined }), pins: PINS },
    fetchBytes: async (url) => { urls.push(url); return GOOD; }, write: (text) => { lines.push(text); }, ...extra,
  });
  return { result, urls, lines };
}

test("the embedded copy is written once to ~/.casper/bin/rg-<sha256>/rg, owner only, and used with no download or line", async () => {
  const { result, urls, lines } = await run({}, await embeddedFile());
  const target = path.join(home, ".casper", "bin", `rg-${digest(GOOD)}`, "rg");
  expect(result).toEqual({ source: "embedded", path: target });
  expect(target).toBe(embeddedRipgrepPath(home, digest(GOOD), "linux"));
  expect(urls).toEqual([]);
  expect(lines).toEqual([]);
  expect(new Uint8Array(await Bun.file(target).arrayBuffer())).toEqual(GOOD);
  if (posix) {
    expect((await stat(target)).mode & 0o777).toBe(0o700);
    expect((await stat(path.dirname(target))).mode & 0o777).toBe(0o700);
  }
  expect(await readdir(path.dirname(target))).toEqual(["rg"]);
  expect(await readdir(path.join(home, ".casper"))).toEqual(["bin"]);
});

test("a good copy already there is reused, not rewritten; a changed one is replaced from the checked bytes", async () => {
  const source = await embeddedFile();
  const first = await run({}, source);
  const file = (first.result as { path: string }).path;
  const old = new Date("2020-01-01T00:00:00Z");
  await utimes(file, old, old);
  resetRipgrep();
  expect((await run({}, source)).result).toEqual({ source: "embedded", path: file });
  expect((await stat(file)).mtime.getTime()).toBe(old.getTime());
  await writeFile(file, "tampered");
  resetRipgrep();
  expect((await run({}, source)).result).toEqual({ source: "embedded", path: file });
  expect(new Uint8Array(await Bun.file(file).arrayBuffer())).toEqual(GOOD);
});

test("an embedded file that does not match the pin is refused: nothing is written or run, and the download takes over", async () => {
  const source = await embeddedFile(new TextEncoder().encode("not ripgrep"));
  expect(await extractEmbeddedRipgrep({ homeDir: home, platform: "linux", arch: "x64", source, pins: PINS })).toEqual({ refused: "the ripgrep inside Casper does not match its pinned checksum" });
  expect(await readdir(path.join(home, ".casper")).catch(() => [])).toEqual([]);
  const { result, urls, lines } = await run({}, source);
  expect(result).toMatchObject({ source: "installed" });
  expect(urls).toHaveLength(1);
  expect(lines[0]).toStartWith("Getting ripgrep");
  expect(await readdir(path.join(home, ".casper", "bin")).catch(() => [])).toEqual([]);
  // With downloads off there is nothing to fall to.
  resetRipgrep();
  const off = await run({ homeDir: path.join(base, "other"), downloads: false }, source);
  expect(off.result).toEqual({ source: "none", why: "off" });
});

test("no embedded file (a source checkout or a build without it): the real import finds none and the download is used", async () => {
  expect(await embeddedSource("linux")).toBeUndefined();
  expect(await embeddedSource("win32")).toBeUndefined();
  expect(await extractEmbeddedRipgrep({ homeDir: home })).toBeUndefined();
  const { result, urls } = await run();
  expect(result).toMatchObject({ source: "installed" });
  expect(urls).toHaveLength(1);
  expect(await readdir(home)).toEqual([".casper"]);
  expect(await readdir(path.join(home, ".casper"))).toEqual(["tools"]);
});

test("a computer Casper has no pin for gets nothing embedded", async () => {
  expect(await extractEmbeddedRipgrep({ homeDir: home, platform: "freebsd" as NodeJS.Platform, arch: "x64", source: await embeddedFile(), pins: PINS })).toBeUndefined();
});

test("Windows names the program rg.exe", async () => {
  const result = await extractEmbeddedRipgrep({ homeDir: home, platform: "win32", arch: "x64", source: await embeddedFile(), pins: PINS });
  expect(result).toEqual({ path: path.join(home, ".casper", "bin", `rg-${digest(GOOD)}`, "rg.exe") });
  expect(embeddedRipgrepPath("/h", "abc", "win32")).toBe(path.join("/h", ".casper", "bin", "rg-abc", "rg.exe"));
});

test("lookup order: PATH, then Pi's copy, then Casper's earlier pinned copy, then the embedded copy, then the download", async () => {
  const source = await embeddedFile();
  const exe = ""; // platform is "linux" in these runs
  // Nothing else: the embedded copy beats the download.
  expect((await run({}, source)).result.source).toBe("embedded");
  // A pinned copy installed earlier wins over the embedded one.
  resetRipgrep();
  expect((await run({ homeDir: path.join(base, "second") }, undefined)).result.source).toBe("installed");
  resetRipgrep();
  const second = await run({ homeDir: path.join(base, "second") }, source);
  expect(second.result).toEqual({ source: "pinned", path: pinnedRipgrepPath(path.join(base, "second"), "linux") });
  // Pi's copy wins over the pinned one.
  const agent = path.join(base, "agent");
  await mkdir(path.join(agent, "bin"), { recursive: true });
  await writeFile(path.join(agent, "bin", `rg${exe}`), "x");
  resetRipgrep();
  expect((await run({ homeDir: path.join(base, "second"), agentDir: agent }, source)).result).toEqual({ source: "agent", path: path.join(agent, "bin", "rg") });
  // A ripgrep on PATH wins over everything, and the embedded copy is not even unpacked.
  const bin = path.join(base, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "rg"), "x");
  resetRipgrep();
  const third = await run({ homeDir: path.join(base, "third"), agentDir: agent, env: { PATH: bin } }, source);
  expect(third.result).toEqual({ source: "path", path: path.join(bin, "rg") });
  expect(await readdir(path.join(base, "third")).catch(() => [])).toEqual([]);
});

test("tools.downloads off and offline stop only the download: the embedded copy is still used", async () => {
  const source = await embeddedFile();
  expect((await run({ downloads: false }, source)).result.source).toBe("embedded");
  resetRipgrep();
  expect((await run({ env: { PATH: empty, CASPER_OFFLINE: "1" } }, source)).result.source).toBe("embedded");
});

test("the real pins: a program digest for every computer, and every release target maps to a pin and a download", () => {
  if (RIPGREP.source.kind !== "binary") throw new Error("ripgrep is a binary pin");
  const keys = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"];
  expect(Object.keys(RIPGREP_BINARY_SHA256).sort()).toEqual(keys);
  for (const key of keys) {
    expect(RIPGREP_BINARY_SHA256[key as keyof typeof RIPGREP_BINARY_SHA256]).toMatch(/^[0-9a-f]{64}$/);
    expect(RIPGREP_BINARY_SHA256[key as keyof typeof RIPGREP_BINARY_SHA256]).not.toBe((RIPGREP.source.assets as Record<string, { sha256: string }>)[key]!.sha256);
  }
  expect(TARGETS).toHaveLength(6);
  for (const target of TARGETS) {
    const key = EMBED_PLATFORMS[target];
    expect({ target, key: key ? "pinned" : "missing" }).toEqual({ target, key: "pinned" });
    expect(RIPGREP.source.assets[key!]).toBeDefined();
    expect(RIPGREP_BINARY_SHA256[key!]).toBeDefined();
    // Bun's x64 builds are baseline builds; they carry the same ripgrep.
    if (target.endsWith("-x64")) expect(EMBED_PLATFORMS[`${target}-baseline`]).toBe(key!);
  }
  expect(Object.keys(EMBED_PLATFORMS).sort()).toEqual(["bun-darwin-arm64", "bun-darwin-x64", "bun-darwin-x64-baseline", "bun-linux-arm64", "bun-linux-x64", "bun-linux-x64-baseline", "bun-windows-arm64", "bun-windows-x64", "bun-windows-x64-baseline"]);
});

/** A one-member .tar.gz and .zip, built by hand, to test the build's unpackers without a real download. */
function tarGz(name: string, body: Uint8Array): Uint8Array {
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf8");
  header.write("0000755\0", 100); header.write("0000000\0", 108); header.write("0000000\0", 116);
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124); header.write("00000000000\0", 136);
  header.write("        ", 148); header.write("0", 156); header.write("ustar\0", 257); header.write("00", 263);
  header.write(`${[...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0")}\0 `, 148);
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  padded.set(body);
  return gzipSync(Buffer.concat([header, padded, Buffer.alloc(1024)]));
}
function zip(name: string, body: Uint8Array, method: 0 | 8): Uint8Array {
  const data = method === 8 ? deflateRawSync(body) : Buffer.from(body);
  const nameBytes = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(method, 8); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(method, 10); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(body.length, 24); central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(0, 42);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  const localPart = Buffer.concat([local, nameBytes, data]);
  const centralPart = Buffer.concat([central, nameBytes]);
  end.writeUInt32LE(centralPart.length, 12); end.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, centralPart, end]);
}

test("the build's unpackers read the one program out of a tar.gz or a zip, and say when it is missing", () => {
  const body = new TextEncoder().encode("program bytes ".repeat(100));
  expect(tarMember(tarGz("ripgrep-1/rg", body), "ripgrep-1/rg")).toEqual(body);
  expect(() => tarMember(tarGz("ripgrep-1/rg", body), "ripgrep-1/other")).toThrow("is not in the ripgrep archive");
  for (const method of [0, 8] as const) {
    expect(zipMember(zip("ripgrep-1/rg.exe", body, method), "ripgrep-1/rg.exe")).toEqual(body);
  }
  expect(() => zipMember(zip("ripgrep-1/rg.exe", body, 8), "ripgrep-1/x")).toThrow("is not in the ripgrep archive");
  expect(() => zipMember(new Uint8Array(40), "x")).toThrow("not a zip file");
});

test("the build refuses a download that does not match its pinned sha256, and writes nothing to embed", async () => {
  const outDir = path.join(base, "embedded");
  const cacheDir = path.join(base, "cache");
  await expect(embedRipgrep("bun-linux-x64", { outDir, cacheDir, fetchBytes: async () => GOOD })).rejects.toThrow("does not match its pinned sha256; nothing was embedded");
  expect(await readdir(outDir).catch(() => [])).toEqual([]);
  expect(await readdir(cacheDir).catch(() => [])).toEqual([]);
  await expect(embedRipgrep("bun-freebsd-x64", { outDir, cacheDir })).rejects.toThrow("No pinned ripgrep");
});
