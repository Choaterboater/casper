/** A picture's file type, read from its first bytes. */

export type PictureFormat = "png" | "jpeg" | "webp";

/** A picture larger than this is not saved. */
export const MAX_PICTURE_BYTES = 20 * 1024 * 1024;

export function imageType(bytes: Uint8Array): PictureFormat | undefined {
  const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
  if (starts(0xff, 0xd8, 0xff)) return "jpeg";
  if (starts(0x52, 0x49, 0x46, 0x46) && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "webp";
  return undefined;
}

/** The format a file name asks for: .png, .jpg/.jpeg or .webp; undefined for anything else. */
export function formatOf(file: string): PictureFormat | undefined {
  const extension = /\.([a-z]+)$/i.exec(file)?.[1]?.toLowerCase();
  return extension === "png" ? "png" : extension === "jpg" || extension === "jpeg" ? "jpeg" : extension === "webp" ? "webp" : undefined;
}

export const EXTENSIONS: Record<PictureFormat, string> = { png: ".png", jpeg: ".jpg", webp: ".webp" };
