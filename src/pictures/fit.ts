/** A picture a tool hands the model, at the size the model may take: the browser's screenshots and MCP pictures. */

import type { RuntimeImage } from "../runtime/types";
import { pictureSize } from "./shrink";

/** Base64 size a picture may have: Pi's read tool keeps the same headroom below Anthropic's 5 MB per image. */
export const PICTURE_MAX_BASE64 = 4.5 * 1024 * 1024;
/** Longest side a picture may have: Pi's read tool shrinks to the same. */
export const PICTURE_MAX_SIDE = 2000;

/** Width and height from a PNG, JPEG, GIF or WebP header, without decoding it; undefined when it can't be read or
 * says 0 px. */
export function headerSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  const gif = bytes.length >= 10 && ["GIF87a", "GIF89a"].includes(Buffer.from(bytes.subarray(0, 6)).toString("latin1"));
  const size = gif ? { width: bytes[6]! | (bytes[7]! << 8), height: bytes[8]! | (bytes[9]! << 8) } : pictureSize(bytes);
  return size && size.width > 0 && size.height > 0 ? size : undefined;
}

/** A picture shrunk to fit, or null when it was not: no image library here, or a body the library can't decode. */
export type Resize = (bytes: Buffer, mimeType: string) => Promise<{ image: RuntimeImage; note?: string } | null>;

/** Shrunk the way Pi's read tool shrinks pictures (at most 2000 px and 4.5 MB of base64), with a note that maps it
 * back when it was resized. Pi is loaded on first use: it is heavy. */
export const piResize: Resize = async (bytes, mimeType) => {
  const { formatDimensionNote, resizeImage } = await import("@earendil-works/pi-coding-agent");
  const fitted = await resizeImage(bytes, mimeType).catch(() => null);
  return fitted ? { image: { data: fitted.data, mimeType: fitted.mimeType }, note: formatDimensionNote(fitted) } : null;
};

// A 1x1 PNG: any image library opens it.
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const libraries = new WeakMap<Resize, Promise<boolean>>();

/** Whether `resize` has an image library, checked once: Pi's resize gives null both when none loads and when it
 * can't decode a body, so this resizes a tiny picture that always decodes. */
export function imageLibraryLoads(resize: Resize = piResize): Promise<boolean> {
  let known = libraries.get(resize);
  if (!known) libraries.set(resize, known = resize(Buffer.from(TINY_PNG, "base64"), "image/png").then(Boolean, () => false));
  return known;
}

/** A picture from outside Casper (an MCP server) at the size the model may take. Not resized: when the image library
 * loaded and could not open it, it is broken (`unopened`), and a provider would refuse the whole request over it.
 * With no image library at all, only a picture whose header says it is within 2000 px and 4.5 MB goes as it is. */
export async function fitImage(base64: string, mimeType: string, resize: Resize = piResize)
  : Promise<{ image?: RuntimeImage; note?: string; unopened?: true }> {
  const bytes = Buffer.from(base64, "base64");
  const fitted = await resize(bytes, mimeType);
  if (fitted) return fitted;
  if (await imageLibraryLoads(resize)) return { unopened: true };
  const size = headerSize(bytes);
  if (size && Math.max(size.width, size.height) <= PICTURE_MAX_SIDE && base64.length < PICTURE_MAX_BASE64) return { image: { data: base64, mimeType } };
  return {};
}
