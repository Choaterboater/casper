/**
 * Puts the official ripgrep for one Bun compile target where the compiled program embeds it
 * (src/security/ripgrep-embedded.ts imports build/embedded/rg, or rg.exe on Windows).
 *
 * The asset comes from the pinned URL in src/security/ripgrep-pin.ts, its sha256 is checked against the pin, only
 * the `rg` / `rg.exe` member is read out of it (no program is run), and that file's sha256 is checked against the
 * per-binary pin before it is written. Anything that does not match stops the build. Verified downloads are kept in
 * build/ripgrep-cache (git-ignored, build-only).
 */
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";
import { RIPGREP, RIPGREP_BINARY_SHA256 } from "../src/security/ripgrep-pin";
import type { BinaryAsset, PlatformKey } from "../src/security/tools";

const repoRoot = path.resolve(import.meta.dir, "..");
export const EMBED_DIR = path.join(repoRoot, "build", "embedded");
export const CACHE_DIR = path.join(repoRoot, "build", "ripgrep-cache");

/** Bun compile target -> the pinned platform. The x64 baseline builds use the same ripgrep as plain x64. */
export const EMBED_PLATFORMS: Record<string, PlatformKey> = {
  "bun-linux-x64": "linux-x64",
  "bun-linux-x64-baseline": "linux-x64",
  "bun-linux-arm64": "linux-arm64",
  "bun-darwin-x64": "darwin-x64",
  "bun-darwin-x64-baseline": "darwin-x64",
  "bun-darwin-arm64": "darwin-arm64",
  "bun-windows-x64": "win32-x64",
  "bun-windows-x64-baseline": "win32-x64",
  "bun-windows-arm64": "win32-arm64",
};

const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** One member's bytes from a .tar.gz (ustar/pax headers; the member is a regular file). */
export function tarMember(archive: Uint8Array, member: string): Uint8Array {
  const tar = gunzipSync(archive);
  let offset = 0;
  let longName: string | undefined;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (from: number, length: number) => Buffer.from(header.subarray(from, from + length)).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(text(124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] ?? 0);
    const prefix = text(345, 155);
    const name = longName ?? (prefix ? `${prefix}/${text(0, 100)}` : text(0, 100));
    const body = tar.subarray(offset + 512, offset + 512 + size);
    longName = undefined;
    if (type === "L") longName = Buffer.from(body).toString("utf8").replace(/\0.*$/s, "");
    else if ((type === "0" || type === "\0") && name === member) return new Uint8Array(body);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`${member} is not in the ripgrep archive`);
}

/** One member's bytes from a .zip (stored or deflated), found through the central directory. */
export function zipMember(archive: Uint8Array, member: string): Uint8Array {
  const data = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength);
  let end = data.length - 22;
  while (end >= 0 && data.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error("the ripgrep archive is not a zip file");
  const count = data.readUInt16LE(end + 10);
  let entry = data.readUInt32LE(end + 16);
  for (let index = 0; index < count; index++) {
    if (data.readUInt32LE(entry) !== 0x02014b50) break;
    const method = data.readUInt16LE(entry + 10);
    const compressed = data.readUInt32LE(entry + 20);
    const nameLength = data.readUInt16LE(entry + 28);
    const extraLength = data.readUInt16LE(entry + 30);
    const commentLength = data.readUInt16LE(entry + 32);
    const local = data.readUInt32LE(entry + 42);
    const name = data.toString("utf8", entry + 46, entry + 46 + nameLength);
    if (name === member) {
      if (data.readUInt32LE(local) !== 0x04034b50) throw new Error("the ripgrep zip is damaged");
      const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
      const raw = data.subarray(start, start + compressed);
      if (method === 0) return new Uint8Array(raw);
      if (method === 8) return new Uint8Array(inflateRawSync(raw));
      throw new Error(`the ripgrep zip uses compression method ${method}`);
    }
    entry += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`${member} is not in the ripgrep archive`);
}

async function archiveBytes(asset: BinaryAsset, fetchBytes: (url: string) => Promise<Uint8Array>, cacheDir: string): Promise<Uint8Array> {
  const cached = path.join(cacheDir, asset.url.split("/").pop()!);
  const known = await readFile(cached).then((bytes) => bytes, () => undefined);
  if (known && sha256(known) === asset.sha256) return known;
  const bytes = await fetchBytes(asset.url);
  if (sha256(bytes) !== asset.sha256) throw new Error(`The ripgrep download ${asset.url} does not match its pinned sha256; nothing was embedded`);
  await mkdir(cacheDir, { recursive: true });
  const temporary = `${cached}.${process.pid}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, cached);
  return bytes;
}

async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`could not download ${url} (HTTP ${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error(`${url} is larger than expected`);
  return bytes;
}

/** Leaves exactly one checked file in build/embedded for this target, and returns its path. */
export async function embedRipgrep(target: string, options: { fetchBytes?: (url: string) => Promise<Uint8Array>; outDir?: string; cacheDir?: string } = {}): Promise<string> {
  const key = EMBED_PLATFORMS[target];
  if (!key) throw new Error(`No pinned ripgrep for ${target}`);
  if (RIPGREP.source.kind !== "binary") throw new Error("ripgrep is a binary pin");
  const asset = RIPGREP.source.assets[key];
  if (!asset) throw new Error(`No pinned ripgrep download for ${key}`);
  const archive = await archiveBytes(asset, options.fetchBytes ?? download, options.cacheDir ?? CACHE_DIR);
  const program = asset.archive === "zip" ? zipMember(archive, asset.member) : tarMember(archive, asset.member);
  if (sha256(program) !== RIPGREP_BINARY_SHA256[key]) throw new Error(`The ripgrep program for ${key} does not match its pinned sha256; nothing was embedded`);
  const dir = options.outDir ?? EMBED_DIR;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, key.startsWith("win32") ? "rg.exe" : "rg");
  await writeFile(file, program);
  await chmod(file, 0o755);
  return file;
}

/** Removes the per-target file so a later checkout build or test compile never embeds a stale one. */
export async function clearEmbedded(dir: string = EMBED_DIR): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
