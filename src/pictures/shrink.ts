/** Web size for a saved picture: one wider or taller than 1600 px or bigger than 400 KB is shrunk with macOS's own
 * sips, else ImageMagick when it is on PATH, else kept as it is (the tool result says so). Casper's fixed arguments
 * only, no shell, on a copy in a temp folder. */

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runImageTool, type ToolRunner } from "../security/spawn";
import { EXTENSIONS, imageType, MAX_PICTURE_BYTES } from "./format";

export const WEB_MAX_SIDE = 1600;
export const WEB_MAX_BYTES = 400 * 1024;
const QUALITY = "82";

export interface ShrinkOptions {
  platform?: NodeJS.Platform;
  /** Where magick or convert is looked for (PATH). */
  env?: NodeJS.ProcessEnv;
  /** macOS's sips; a test points it at a fake. */
  sips?: string;
  run?: ToolRunner;
}

/** Width and height from a PNG, JPEG or WebP header; undefined when it can't be read. */
export function pictureSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = imageType(bytes);
  if (type === "png" && bytes.length >= 24) return { width: view.getUint32(16), height: view.getUint32(20) };
  if (type === "webp" && bytes.length >= 30) {
    const chunk = String.fromCharCode(...bytes.subarray(12, 16));
    const u24 = (at: number) => bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16);
    if (chunk === "VP8X") return { width: 1 + u24(24), height: 1 + u24(27) };
    if (chunk === "VP8 ") return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    if (chunk === "VP8L") { const bits = view.getUint32(21, true); return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) }; }
    return undefined;
  }
  if (type === "jpeg") {
    for (let at = 2; at + 9 < bytes.length;) {
      if (bytes[at] !== 0xff) return undefined;
      const marker = bytes[at + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: view.getUint16(at + 7), height: view.getUint16(at + 5) };
      at += 2 + view.getUint16(at + 2);
    }
  }
  return undefined;
}

/** The picture at web size, or as it is with a note saying why it was not shrunk. `keepPng` keeps a PNG (transparency
 * or a .png asked for); otherwise the result is a JPEG. */
export async function webSize(bytes: Uint8Array, keepPng: boolean, options: ShrinkOptions = {}, signal?: AbortSignal)
  : Promise<{ bytes: Uint8Array; note?: string }> {
  const size = pictureSize(bytes);
  const tooWide = Boolean(size && Math.max(size.width, size.height) > WEB_MAX_SIDE);
  if (!tooWide && bytes.length <= WEB_MAX_BYTES) return { bytes };
  const what = `${size ? `${size.width}x${size.height}, ` : ""}${Math.round(bytes.length / 1024)} KB`;
  const platform = options.platform ?? process.platform;
  const sips = options.sips ?? "/usr/bin/sips";
  const PATH = (options.env ?? process.env).PATH ?? "";
  const magick = Bun.which("magick", { PATH }) ?? (platform === "win32" ? null : Bun.which("convert", { PATH }));
  const toPng = keepPng && imageType(bytes) === "png";
  const out = toPng ? "web.png" : "web.jpg";
  let plan: { file: string; args: (input: string, output: string) => string[] } | undefined;
  if (platform === "darwin" && existsSync(sips)) {
    plan = { file: sips, args: (input, output) => [...(tooWide ? ["-Z", String(WEB_MAX_SIDE)] : []),
      ...(toPng ? ["-s", "format", "png"] : ["-s", "format", "jpeg", "-s", "formatOptions", QUALITY]), input, "--out", output] };
  } else if (magick) {
    plan = { file: magick, args: (input, output) => [input, "-resize", `${WEB_MAX_SIDE}x${WEB_MAX_SIDE}>`,
      ...(toPng ? [] : ["-background", "white", "-flatten", "-quality", QUALITY]), output] };
  }
  if (!plan) return { bytes, note: `kept at full size (${what}): no sips or ImageMagick here to shrink it` };
  const folder = await mkdtemp(path.join(os.tmpdir(), "casper-web-size-"));
  try {
    const input = path.join(folder, `in${EXTENSIONS[imageType(bytes) ?? "png"]}`), output = path.join(folder, out);
    await writeFile(input, bytes);
    const result = await (options.run ?? runImageTool)({ file: plan.file, args: plan.args(input, output), cwd: folder, env: { PATH },
      timeoutMs: 60_000, maxStdoutBytes: 64 * 1024, ...(signal ? { signal } : {}) });
    const made = result.exitCode === 0 ? new Uint8Array(await readFile(output).catch(() => Buffer.alloc(0))) : new Uint8Array();
    if (made.length && made.length <= MAX_PICTURE_BYTES && imageType(made) === (toPng ? "png" : "jpeg")) return { bytes: made };
    return { bytes, note: `kept at full size (${what}): ${path.basename(plan.file)} could not shrink it` };
  } finally { await rm(folder, { recursive: true, force: true }).catch(() => {}); }
}
