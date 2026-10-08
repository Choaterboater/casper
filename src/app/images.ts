/**
 * Pictures with a request: an image pasted with Ctrl+V, or an image file dropped (or typed) into the prompt.
 * Each becomes `[image N]` in the request text and goes to the model as an image. A dropped file's path is kept
 * on a line under the request, so the model can still copy or move the file. A pasted picture has no file, so it is
 * saved to a private folder for the session and that path goes on the same kind of line.
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/** Where the pasted pictures' folder is made: the temp folder, except on Windows. There chmod sets no ACL, so a folder
 * in %TEMP% gets whatever that folder grants (a shared C:\Temp, or users a tool added to it). ~/.casper is in your
 * profile, which Windows keeps to you (and SYSTEM and Administrators). */
export function pastedFolderParent(platform: NodeJS.Platform = process.platform, home: string = os.homedir()): string {
  return platform === "win32" ? path.join(home, ".casper", "pasted") : os.tmpdir();
}

/** Pasted pictures saved as files for one session, in one private folder (0700, files 0600) made on the first save. */
export class PastedImageFiles {
  private folder?: Promise<string>;
  private removed = false;
  constructor(private readonly root: string | (() => string) = () => pastedFolderParent()) {}

  /** Saves the picture and returns its absolute path; undefined when it could not be written, or after remove() (a
   * picture sent as the session closes would make a folder that nothing deletes). */
  async save(number: number, image: RuntimeImage): Promise<string | undefined> {
    if (this.removed) return undefined;
    try {
      const root = typeof this.root === "string" ? this.root : this.root();
      this.folder ??= mkdir(root, { recursive: true, mode: 0o700 }).then(() => mkdtemp(path.join(root, "casper-pasted-")))
        .then(async (dir) => { await chmod(dir, 0o700); return dir; });
      const dir = await this.folder;
      const file = path.join(dir, `pasted-image-${number}-${randomBytes(4).toString("hex")}.${EXTENSIONS[image.mimeType] ?? "png"}`);
      await writeFile(file, Buffer.from(image.data, "base64"), { flag: "wx", mode: 0o600 });
      return file;
    } catch { return undefined; }
  }

  /** Deletes the folder and every picture in it; nothing is saved after this. */
  async remove(): Promise<void> {
    this.removed = true;
    const folder = this.folder;
    this.folder = undefined;
    const dir = await folder?.catch(() => undefined);
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export const imageLabel = (number: number) => `[image ${number}]`;

const EXTENSION = String.raw`\.(?:png|jpe?g|gif|webp)`;
/** A quoted path, or an unquoted one that starts at / or ~/ (POSIX, spaces escaped as `\ `), or at a drive letter
 * (Windows). Bare names ("logo.png") are words about the project, never attachments. */
function pathPattern(platform: NodeJS.Platform): RegExp {
  const start = platform === "win32" ? String.raw`(?:[A-Za-z]:[\\/]|~[\\/]|\\\\)` : String.raw`(?:~\/|\/)`;
  const unquoted = platform === "win32" ? String.raw`[^\s"']*?` : String.raw`(?:\\.|[^\s"'\\])*?`;
  return new RegExp(String.raw`(["'])(${start}(?:(?!\1)[^\n])*?${EXTENSION})\1|(?<=^|\s)(${start}${unquoted}${EXTENSION})(?=$|[\s,;:)!?])`, "gi");
}

/** A file's path as the prompt takes it: in double quotes, or single ones when the name has a double quote; with both,
 * each space, quote and backslash escaped (POSIX; a Windows name never has a double quote). */
export function promptPath(file: string): string {
  if (!file.includes('"')) return `"${file}"`;
  if (!file.includes("'")) return `'${file}'`;
  return file.replace(/[\s"'\\]/g, "\\$&");
}

export interface AttachOptions {
  cwd: string;
  home?: string;
  /** Pictures pasted into the prompt, by their number in `[image N]`. */
  pasted?: ReadonlyMap<number, RuntimeImage>;
  /** Where pasted pictures are saved so the model has a path for them; without it they are only sent inline. */
  saveTo?: PastedImageFiles;
  platform?: NodeJS.Platform;
  /** Where a typed path is on disk (tests stand in for a Windows disk). */
  resolve?: (typed: string) => string;
  /**
   * Windows: asked once per computer before a picture on a network share (\\host\share\pic.png) is opened, since
   * opening it sends your Windows login (a hash of it) to that computer. Without it, such a picture is not opened.
   */
  confirmShare?: (file: string, host: string) => Promise<boolean>;
}

/** The computer a Windows network path (\\host\share, //host/share, \\?\UNC\host) names; undefined for a local path.
 * Any other device path but a drive's (\\?\GLOBALROOT\Device\Mup\host\…) may reach another computer too, so it
 * counts as one: named by the computer where the path says it, else by its first part. */
export function shareHost(file: string): string | undefined {
  const device = /^[\\/]{2}[?.][\\/]([^\\/]*)/.exec(file);
  if (device) {
    if (/^[A-Za-z]:$/.test(device[1]!)) return undefined;
    const named = /^[\\/]{2}[?.][\\/]+(?:UNC|GLOBALROOT[\\/]+Device[\\/]+Mup)[\\/]+([^\\/]+)/i.exec(file);
    return named?.[1] ?? (device[1] || "?");
  }
  const plain = /^[\\/]{2}([^\\/?.][^\\/]*|\.[^\\/]+)/.exec(file);
  return plain?.[1];
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
  const shares = new Map<string, boolean>();
  let out = "";
  let last = 0;
  for (const match of text.matchAll(pathPattern(platform))) {
    const typed = match[2] ?? match[3]!;
    const quoted = match[2] !== undefined;
    const plain = !quoted && platform !== "win32" ? typed.replace(/\\(.)/g, "$1") : typed;
    const expanded = /^~[\\/]/.test(plain) ? path.join(home, plain.slice(2)) : plain;
    const file = options.resolve ? options.resolve(expanded) : path.resolve(options.cwd, expanded);
    // Only on Windows does a path like this reach another computer; a no leaves it as words in the request.
    const host = platform === "win32" ? shareHost(expanded) ?? shareHost(file) : undefined;
    if (host !== undefined) {
      if (numbered.size >= MAX_IMAGES) { limited = true; continue; }
      const key = host.toLowerCase();
      if (!shares.has(key)) shares.set(key, await options.confirmShare?.(expanded, host).catch(() => false) ?? false);
      if (!shares.get(key)) { notes.push(`${expanded} is on another computer (${host}); not opened, so not attached`); continue; }
    }
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
  const saved: string[] = [];
  if (options.saveTo) {
    for (const [number, image] of [...numbered.entries()].sort(([a], [b]) => a - b)) {
      if (!pasted.has(number)) continue;
      const file = await options.saveTo.save(number, image);
      if (file) saved.push(`${imageLabel(number)} is the file ${file}`);
    }
  }
  files.unshift(...saved);
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
