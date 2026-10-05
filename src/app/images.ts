/**
 * Pictures with a request: an image pasted with Ctrl+V, or an image file dropped (or typed) into the prompt.
 * Each becomes `[image N]` in the request text and goes to the model as an image. A dropped file's path is kept
 * on a line under the request, so the model can still copy or move the file.
 */
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RuntimeImage } from "../runtime/types";

/** At most this many pictures go with one request. */
export const MAX_IMAGES = 8;
/** A file larger than this is not read (the runtime shrinks pictures to what the model takes). */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** The picture type from the file's first bytes; undefined when it is not PNG, JPEG, GIF or WebP. */
export function imageMimeType(bytes: Uint8Array): string | undefined {
  const head = Buffer.from(bytes.subarray(0, 12));
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.subarray(0, 6).toString("latin1") === "GIF87a" || head.subarray(0, 6).toString("latin1") === "GIF89a") return "image/gif";
  if (head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return undefined;
}

export const imageLabel = (number: number) => `[image ${number}]`;

const EXTENSION = String.raw`\.(?:png|jpe?g|gif|webp)`;
/** A quoted path, or an unquoted one that starts at / or ~/ (POSIX, spaces escaped as `\ `), or at a drive letter
 * (Windows). Bare names ("logo.png") are words about the project, never attachments. */
function pathPattern(platform: NodeJS.Platform): RegExp {
  const start = platform === "win32" ? String.raw`(?:[A-Za-z]:[\\/]|~[\\/]|\\\\)` : String.raw`(?:~\/|\/)`;
  const unquoted = platform === "win32" ? String.raw`[^\s"']*?` : String.raw`(?:\\.|[^\s"'\\])*?`;
  return new RegExp(String.raw`(["'])(${start}[^"'\n]*?${EXTENSION})\1|(?<=^|\s)(${start}${unquoted}${EXTENSION})(?=$|[\s,;:)!?])`, "gi");
}

export interface AttachOptions {
  cwd: string;
  home?: string;
  /** Pictures pasted into the prompt, by their number in `[image N]`. */
  pasted?: ReadonlyMap<number, RuntimeImage>;
  platform?: NodeJS.Platform;
  /** Where a typed path is on disk (tests stand in for a Windows disk). */
  resolve?: (typed: string) => string;
}

export interface Attached {
  /** The request with each picture as `[image N]`, and a line per dropped file saying which file it is. */
  text: string;
  /** In `[image N]` order. */
  images: RuntimeImage[];
  /** One line each for a file that was not attached (not a picture, too big, past the limit). */
  notes: string[];
}

/** The request's pictures: pasted ones still named in the text, then files whose paths are in it. */
export async function attachImages(text: string, options: AttachOptions): Promise<Attached> {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  const pasted = options.pasted ?? new Map<number, RuntimeImage>();
  const numbered = new Map<number, RuntimeImage>();
  for (const [number, image] of pasted) if (text.includes(imageLabel(number)) && numbered.size < MAX_IMAGES) numbered.set(number, image);
  let next = Math.max(0, ...pasted.keys()) + 1;
  const notes: string[] = [];
  const files: string[] = [];
  let limited = false;
  let out = "";
  let last = 0;
  for (const match of text.matchAll(pathPattern(platform))) {
    const typed = match[2] ?? match[3]!;
    const quoted = match[2] !== undefined;
    const plain = !quoted && platform !== "win32" ? typed.replace(/\\(.)/g, "$1") : typed;
    const expanded = /^~[\\/]/.test(plain) ? path.join(home, plain.slice(2)) : plain;
    const file = options.resolve ? options.resolve(expanded) : path.resolve(options.cwd, expanded);
    const image = await readImage(file, notes);
    if (!image) continue;
    if (numbered.size >= MAX_IMAGES) { limited = true; continue; }
    numbered.set(next, image);
    files.push(`${imageLabel(next)} is the file ${expanded}`);
    out += text.slice(last, match.index) + imageLabel(next);
    last = match.index! + match[0].length;
    next++;
  }
  out += text.slice(last);
  if (limited) notes.push(`Only ${MAX_IMAGES} pictures go with one request; the rest stay as file names`);
  const images = [...numbered.entries()].sort(([a], [b]) => a - b).map(([, image]) => image);
  return { text: files.length ? `${out}\n\n${files.join("\n")}` : out, images, notes };
}

/** The picture path a line starts with, as typed (unescaped, ~ expanded); undefined when it starts with anything else. */
export function leadingImagePath(text: string, options: Pick<AttachOptions, "home" | "platform"> = {}): string | undefined {
  const platform = options.platform ?? process.platform;
  const match = pathPattern(platform).exec(text);
  if (!match || match.index !== 0 || match[3] === undefined) return undefined;
  const plain = platform !== "win32" ? match[3].replace(/\\(.)/g, "$1") : match[3];
  return /^~[\\/]/.test(plain) ? path.join(options.home ?? os.homedir(), plain.slice(2)) : plain;
}

/** Whether the line starts with a picture file's path (a file dropped into an empty prompt): a request, not a
 * slash command. Only an existing file counts, so a command name never does. */
export async function startsWithImageFile(text: string, options: Pick<AttachOptions, "cwd" | "home" | "platform">): Promise<boolean> {
  const typed = leadingImagePath(text, options);
  if (typed === undefined) return false;
  try { return (await stat(path.resolve(options.cwd, typed))).isFile(); } catch { return false; }
}

/** The file as a picture; undefined (with a note when it matters) when it is missing, too big or not a picture. */
async function readImage(file: string, notes: string[]): Promise<RuntimeImage | undefined> {
  let size: number;
  try {
    const info = await stat(file);
    if (!info.isFile()) return undefined;
    size = info.size;
  } catch { return undefined; }
  if (size > MAX_IMAGE_BYTES) { notes.push(`${file} is over ${MAX_IMAGE_BYTES / 1024 / 1024} MB; not attached`); return undefined; }
  let bytes: Buffer;
  try { bytes = await readFile(file); } catch { return undefined; }
  const mimeType = imageMimeType(bytes);
  if (!mimeType) { notes.push(`${file} is not a PNG, JPEG, GIF or WebP picture; not attached`); return undefined; }
  return { data: bytes.toString("base64"), mimeType };
}
