/** A picture a tool hands the model, at the size the model may take: the browser's screenshots and MCP pictures. */

import type { RuntimeImage } from "../runtime/types";

/** Base64 size a picture may have: Pi's read tool keeps the same headroom below Anthropic's 5 MB per image. */
export const PICTURE_MAX_BASE64 = 4.5 * 1024 * 1024;

/** Shrunk the way Pi's read tool shrinks pictures (at most 2000 px and 4.5 MB of base64), with a note that maps it
 * back when it was resized. No image when it can't be made small enough. Pi is loaded on first use: it is heavy. */
export async function fitImage(base64: string, mimeType: string): Promise<{ image?: RuntimeImage; note?: string }> {
  const { formatDimensionNote, resizeImage } = await import("@earendil-works/pi-coding-agent");
  const fitted = await resizeImage(Buffer.from(base64, "base64"), mimeType).catch(() => null);
  if (fitted) return { image: { data: fitted.data, mimeType: fitted.mimeType }, note: formatDimensionNote(fitted) };
  // No image library here: a picture already small enough still goes as it is.
  if (base64.length < PICTURE_MAX_BASE64) return { image: { data: base64, mimeType } };
  return {};
}
