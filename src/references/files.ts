import { openNoFollow } from "../platform/files";

/** Shared reference/config reader: no scripts, final symlinks, FIFO waits, or unbounded reads. */
export async function readReferenceFile(filePath: string, maxBytes: number): Promise<Buffer> {
  const file = await openNoFollow(filePath);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("not a regular file");
    if (info.size > maxBytes) throw new Error(`file exceeds ${maxBytes} bytes`);
    const buffer = Buffer.alloc(maxBytes + 1);
    let count = 0;
    while (count < buffer.length) {
      const result = await file.read(buffer, count, buffer.length - count, count);
      if (!result.bytesRead) break;
      count += result.bytesRead;
    }
    if (count > maxBytes) throw new Error(`file exceeds ${maxBytes} bytes`);
    return buffer.subarray(0, count);
  } finally { await file.close(); }
}

export function referenceText(bytes: Uint8Array): string {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.includes("\0")) throw new Error("binary content is not searched");
  return text;
}
