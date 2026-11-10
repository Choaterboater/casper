/** A picture's width and height from its header, read before it is decoded (decision 99): a small file can unpack to
 * gigabytes. Each bitstream or frame a decoder makes room for is checked (a GIF's first frame, every WebP frame), so a
 * header that could hide a bigger one is malformed and gives no size. A saved picture's web size keeps the looser
 * `pictureSize` (./shrink): there a size only decides whether to shrink. */

type Size = { width: number; height: number };

/** Width and height from a PNG, JPEG, GIF or WebP header, without decoding it; undefined when it can't be read, is
 * malformed or says 0 px. */
export function headerSize(bytes: Uint8Array): Size | undefined {
  const starts = (text: string) => Buffer.from(bytes.subarray(0, text.length)).toString("latin1") === text;
  const size = starts("\x89PNG\r\n\x1a\n") ? pngSize(bytes)
    : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? jpegSize(bytes)
    : starts("GIF87a") || starts("GIF89a") ? gifSize(bytes)
    : starts("RIFF") && Buffer.from(bytes.subarray(8, 12)).toString("latin1") === "WEBP" ? webpSize(bytes)
    : undefined;
  return size && size.width > 0 && size.height > 0 ? size : undefined;
}

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const text = (bytes: Uint8Array, at: number) => Buffer.from(bytes.subarray(at, at + 4)).toString("latin1");

/** IHDR's size; IHDR must be the first chunk, 13 bytes long: a made-up first chunk would otherwise read as its own. */
function pngSize(bytes: Uint8Array): Size | undefined {
  if (bytes.length < 24 || view(bytes).getUint32(8) !== 13 || text(bytes, 12) !== "IHDR") return undefined;
  return { width: view(bytes).getUint32(16), height: view(bytes).getUint32(20) };
}

/** The first SOFn's size. Any number of 0xFF fill bytes may come before a marker, and every segment up to and with the
 * frame must fit in the file; a marker with no length before the frame is malformed. */
function jpegSize(bytes: Uint8Array): Size | undefined {
  const data = view(bytes);
  for (let at = 2; at < bytes.length;) {
    if (bytes[at] !== 0xff) return undefined;
    while (bytes[at + 1] === 0xff) at++;
    if (at + 4 > bytes.length) return undefined;
    const marker = bytes[at + 1]!, length = data.getUint16(at + 2);
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) return undefined;
    if (length < 2 || at + 2 + length > bytes.length) return undefined;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return length >= 7 ? { width: data.getUint16(at + 7), height: data.getUint16(at + 5) } : undefined;
    }
    at += 2 + length;
  }
  return undefined;
}

/** A decoder makes room for the first frame at its image descriptor's size, which may be bigger than the logical
 * screen, so each side is the larger of the two. The descriptor comes after the global colour table and any
 * extension blocks; a GIF with no frame, or cut short before it, gives no size. */
function gifSize(bytes: Uint8Array): Size | undefined {
  if (bytes.length < 13) return undefined;
  const u16 = (at: number) => bytes[at]! | (bytes[at + 1]! << 8);
  let at = 13 + (bytes[10]! & 0x80 ? 3 * 2 ** ((bytes[10]! & 7) + 1) : 0);
  while (at < bytes.length && bytes[at] === 0x21) {
    // An extension: its label, then sub-blocks, each a length byte and that many bytes, until a 0 length.
    at += 2;
    for (let length = -1; length !== 0; at += 1 + length) {
      if (at >= bytes.length) return undefined;
      length = bytes[at]!;
    }
  }
  if (bytes[at] !== 0x2c || at + 10 > bytes.length) return undefined;
  return { width: Math.max(u16(6), u16(at + 5)), height: Math.max(u16(8), u16(at + 7)) };
}

/** A WebP's canvas is its VP8X chunk's, or a simple one's single VP8 or VP8L bitstream's. A decoder makes room for
 * each frame's own bitstream, wherever it sits, then crops it: so every chunk to the end of the file is walked (with an
 * odd-sized one's pad byte), and every VP8 or VP8L frame must be within the canvas, and every ANMF frame inside it with
 * its bitstream within the frame. A still picture has one frame and an animated one only ANMF frames; anything else,
 * or a chunk that does not fit the file, gives no size. */
function webpSize(bytes: Uint8Array): Size | undefined {
  const first = chunkAt(bytes, 12, bytes.length);
  if (!first) return undefined;
  const u24 = (at: number) => bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16);
  const canvas = first.type !== "VP8X" ? bitstreamSize(bytes, first)
    : first.size >= 10 ? { width: 1 + u24(first.data + 4), height: 1 + u24(first.data + 7) } : undefined;
  if (!canvas) return undefined;
  let stills = 0, animated = 0;
  const walked = walkChunks(bytes, first.type === "VP8X" ? first.next : 12, bytes.length, (chunk) => {
    if (chunk.type === "VP8 " || chunk.type === "VP8L") {
      return ++stills === 1 && within(bitstreamSize(bytes, chunk), canvas);
    }
    if (chunk.type !== "ANMF") return true;
    animated++;
    if (chunk.size < 16) return false;
    const x = 2 * u24(chunk.data), y = 2 * u24(chunk.data + 3);
    const frame = { width: 1 + u24(chunk.data + 6), height: 1 + u24(chunk.data + 9) };
    if (x + frame.width > canvas.width || y + frame.height > canvas.height) return false;
    let bitstreams = 0;
    const inside = walkChunks(bytes, chunk.data + 16, chunk.data + chunk.size, (inner) =>
      (inner.type !== "VP8 " && inner.type !== "VP8L") || (++bitstreams === 1 && within(bitstreamSize(bytes, inner), frame)));
    return inside && bitstreams === 1;
  });
  return walked && (stills === 1) !== (animated > 0) ? canvas : undefined;
}

const within = (inner: Size | undefined, outer: Size) =>
  !!inner && inner.width <= outer.width && inner.height <= outer.height;

/** Calls `check` on each RIFF chunk from `at` until `end`; false when a check fails or a chunk does not fit before
 * `end`. The last chunk's pad byte may be missing. */
function walkChunks(bytes: Uint8Array, at: number, end: number, check: (chunk: Chunk) => boolean): boolean {
  while (at < end) {
    const chunk = chunkAt(bytes, at, end);
    if (!chunk || !check(chunk)) return false;
    at = chunk.next;
  }
  return true;
}

type Chunk = { type: string; data: number; size: number; next: number };

/** The RIFF chunk at `at`, when its header and data fit before `end`. */
function chunkAt(bytes: Uint8Array, at: number, end: number): Chunk | undefined {
  if (at + 8 > end) return undefined;
  const size = view(bytes).getUint32(at + 4, true);
  if (at + 8 + size > end) return undefined;
  return { type: text(bytes, at), data: at + 8, size, next: at + 8 + size + (size & 1) };
}

/** A VP8 or VP8L bitstream's own size, from its frame header; undefined when the header is not one. */
function bitstreamSize(bytes: Uint8Array, chunk: Chunk): Size | undefined {
  const data = view(bytes), at = chunk.data;
  if (chunk.type === "VP8 " && chunk.size >= 10 && bytes[at + 3] === 0x9d && bytes[at + 4] === 0x01 && bytes[at + 5] === 0x2a) {
    return { width: data.getUint16(at + 6, true) & 0x3fff, height: data.getUint16(at + 8, true) & 0x3fff };
  }
  if (chunk.type === "VP8L" && chunk.size >= 5 && bytes[at] === 0x2f) {
    const bits = data.getUint32(at + 1, true);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
  }
  return undefined;
}
