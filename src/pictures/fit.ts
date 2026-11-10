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

/** Shrunk the way Pi's read tool shrinks pictures (at most 2000 px and 4.5 MB of base64), with a note that maps it
 * back when it was resized. No image when it can't be made small enough. Pi is loaded on first use: it is heavy. */
export async function fitImage(base64: string, mimeType: string): Promise<{ image?: RuntimeImage; note?: string }> {
  const { formatDimensionNote, resizeImage } = await import("@earendil-works/pi-coding-agent");
  const bytes = Buffer.from(base64, "base64");
  const fitted = await resizeImage(bytes, mimeType).catch(() => null);
  if (fitted) return { image: { data: fitted.data, mimeType: fitted.mimeType }, note: formatDimensionNote(fitted) };
  // Not resized: no image library here, or a body it can't decode. Only a picture whose header says it is already
  // small enough still goes as it is.
  const size = headerSize(bytes);
  if (size && Math.max(size.width, size.height) <= PICTURE_MAX_SIDE && base64.length < PICTURE_MAX_BASE64) return { image: { data: base64, mimeType } };
  return {};
}
