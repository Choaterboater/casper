/**
 * Pictures in an MCP result (decision 99). An `image` block that holds a PNG, JPEG, GIF or WebP goes to the model as a
 * picture, after the result's text, the way a pasted picture does; a model that can't see images gets the text and a
 * note (src/runtime/pi.ts toolContent). The block stays in the text as one short line: its type, mimeType and number.
 * Audio, resource blobs, other image types and every picture in an error result stay out with today's note
 * (boundCapabilityResult).
 */

import { imageMimeType, MAX_IMAGE_BYTES, MAX_IMAGES } from "../app/images";
import { isRecord } from "../mcp/config";
import { fitImage } from "../pictures/fit";
import type { RuntimeImage } from "../runtime/types";

export type FitPicture = (base64: string, mimeType: string) => Promise<{ image?: RuntimeImage; note?: string }>;

/** Bytes a base64 string decodes to, without decoding it. */
function decodedBytes(base64: string): number {
  const plain = base64.replace(/\s+/g, "");
  return Math.floor(plain.length * 3 / 4) - (plain.endsWith("==") ? 2 : plain.endsWith("=") ? 1 : 0);
}

/**
 * Take the pictures out of one MCP result. Each one kept leaves `{ type: "image", mimeType, picture: N }` (and the
 * shrink note, when it was shrunk) where it was. The limits are the ones a request's pictures have: at most
 * MAX_IMAGES per result and MAX_IMAGE_BYTES each, then shrunk as Pi's read tool shrinks a picture. One past them
 * stays out with a line that says why. Pictures shrink at the same time (each in its own worker), and Stop ends the
 * wait at once: the call already ran, so the result still comes back, with the pictures not yet shrunk left out.
 * Runs before the secret scrub: base64 has no text to scrub.
 */
export async function takePictures(value: unknown, fit: FitPicture = fitImage, signal?: AbortSignal): Promise<{ value: unknown; images: RuntimeImage[] }> {
  if (!isRecord(value) || !Array.isArray(value.content) || value.isError === true) return { value, images: [] };
  if (!value.content.some((block) => isRecord(block) && block.type === "image")) return { value, images: [] };
  // First pass: what each block is, so the pictures in the count can shrink together.
  type Slot = { block: unknown } | { metadata: Record<string, unknown>; why: string } | { metadata: Record<string, unknown>; fitted: Promise<Fitted> };
  const slots: Slot[] = [];
  let wanted = 0;
  for (const block of value.content) {
    if (!isRecord(block) || block.type !== "image" || typeof block.data !== "string") { slots.push({ block }); continue; }
    const mimeType = imageMimeType(Buffer.from(block.data.slice(0, 24), "base64"));
    // Not a picture a model takes (an SVG, a TIFF): left as it is, so it stays out with today's note.
    if (!mimeType) { slots.push({ block }); continue; }
    const { data, ...metadata } = block;
    if (wanted >= MAX_IMAGES) slots.push({ metadata, why: `at most ${MAX_IMAGES} per result` });
    else if (decodedBytes(data) > MAX_IMAGE_BYTES) slots.push({ metadata, why: `over ${MAX_IMAGE_BYTES / 1024 / 1024} MB` });
    else { wanted++; slots.push({ metadata, fitted: untilStopped(() => fit(data, mimeType), signal) }); }
  }
  if (slots.every((slot) => "block" in slot)) return { value, images: [] };
  const images: RuntimeImage[] = [];
  const content: unknown[] = [];
  for (const slot of slots) {
    if ("block" in slot) { content.push(slot.block); continue; }
    const fitted = "fitted" in slot ? await slot.fitted : slot.why;
    if (typeof fitted === "string" || !fitted.image) {
      content.push({ ...slot.metadata, omitted: `picture left out: ${typeof fitted === "string" ? fitted : "too large to send"}` });
      continue;
    }
    images.push(fitted.image);
    content.push({ ...slot.metadata, mimeType: fitted.image.mimeType, picture: images.length, ...(fitted.note ? { note: fitted.note } : {}) });
  }
  return { value: { ...value, content }, images };
}

type Fitted = Awaited<ReturnType<FitPicture>> | "stopped";

/** One shrink, or "stopped" as soon as the call is stopped (a shrink under way finishes in its worker and is dropped). */
function untilStopped(work: () => ReturnType<FitPicture>, signal?: AbortSignal): Promise<Fitted> {
  if (signal?.aborted) return Promise.resolve("stopped");
  const fitted = work().catch(() => ({}));
  if (!signal) return fitted;
  return new Promise((resolve) => {
    const stop = () => resolve("stopped");
    signal.addEventListener("abort", stop, { once: true });
    void fitted.then((result) => { signal.removeEventListener("abort", stop); resolve(result); });
  });
}

/** The summary's line for the pictures that follow the result. */
export function picturesLine(count: number): string {
  return count === 1 ? "1 picture follows this result." : `${count} pictures follow this result, in order.`;
}
