// An ACP prompt's content blocks as the request Casper runs (decision 78). Words stay words; a picture becomes
// `[image N]` and goes to the run as a Ctrl+V picture does in the terminal; a file goes as its quoted path, so Casper
// reads it with its own file tools (and a picture file is attached by the terminal's quoted-path rule). Anything
// Casper can't take gets one plain note for the person instead.

import path from "node:path";
import { imageLabel, imageMimeType, MAX_IMAGE_BYTES, MAX_IMAGES, PICTURE_PATH, promptPath, shareHost } from "../app/images";
import type { RuntimeImage } from "../runtime/types";
import { RpcFailure, RPC, type Json } from "./rpc";

/** Embedded text up to this many bytes goes with the request whole. */
export const MAX_EMBEDDED_TEXT = 256 * 1024;

export interface PromptContent {
  /** The request: each block's words in the order the client sent them, a picture as `[image N]`. */
  text: string;
  /** The pictures, by their number in `[image N]`. */
  images: Map<number, RuntimeImage>;
  /** One line each for what was not sent, for the person (Casper sends them prefixed `[image] `). */
  notes: string[];
}

/** A word or a name from the client, on one line and not too long for a note. */
const oneLine = (value: string, max = 200) => value.replace(/[\u0000-\u001f\u007f\u2028\u2029\s]+/g, " ").trim().slice(0, max);

function sizeWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The local path a `file:` address names, as `platform` writes paths: a Windows share (file://host/share/x) is
 * \\host\share\x there; elsewhere a host means another computer, so it is no local file. Undefined for anything else. */
export function fileUriPath(uri: string, platform: NodeJS.Platform = process.platform): string | undefined {
  let url: URL;
  try { url = new URL(uri); } catch { return undefined; }
  if (url.protocol !== "file:") return undefined;
  // An encoded slash would make a path the address does not show (Node's fileURLToPath refuses it too).
  if (/%2f/i.test(url.pathname) || (platform === "win32" && /%5c/i.test(url.pathname))) return undefined;
  let pathname: string;
  try { pathname = decodeURIComponent(url.pathname); } catch { return undefined; }
  if (pathname.includes("\0")) return undefined;
  const host = url.hostname && url.hostname !== "localhost" ? url.hostname : "";
  if (platform === "win32") {
    if (host) return `\\\\${host}${pathname.replace(/\//g, "\\")}`;
    return (/^\/[A-Za-z]:/.test(pathname) ? pathname.slice(1) : pathname).replace(/\//g, "\\");
  }
  return host ? undefined : pathname;
}

/** The path a link's file goes to the model as. On Windows a picture on a share goes as its share path, which the share
 * box asks about before it is opened (opening a share sends your Windows login, a hash of it, there); any other file on
 * a share stays an address, as it does elsewhere, so the model is never handed a share to open unasked. */
function linkedFile(uri: string, platform: NodeJS.Platform): string | undefined {
  const file = fileUriPath(uri, platform);
  if (file && platform === "win32" && shareHost(file) !== undefined && !PICTURE_PATH.test(file)) return undefined;
  return file;
}

/** The line that names a file for the model: its name, its size when known, and its quoted path. */
function fileLine(file: string, name: unknown, size: number | undefined, platform: NodeJS.Platform): string {
  const shown = typeof name === "string" && oneLine(name) ? oneLine(name) : (platform === "win32" ? path.win32 : path.posix).basename(file);
  return `Attached file ${shown}${size !== undefined ? ` (${sizeWords(size)})` : ""}: ${promptPath(file)}`;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Roughly how many bytes base64 `data` holds, without decoding it. */
const base64Bytes = (data: string) => Math.floor(data.length * 3 / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);

/** The picture type of base64 `data` from its first bytes, read without decoding the rest. */
const sniff = (data: string) => imageMimeType(Buffer.from(data.slice(0, 24), "base64"));

/**
 * The prompt's blocks as one request. `text` keeps the blocks' order; pictures past the eighth, over 20 MB or not a
 * PNG, JPEG, GIF or WebP, audio and blocks Casper can't read each leave a note. Refused (-32602) when the list is not
 * one, or when it has no words and no picture.
 */
export function promptContent(blocks: unknown, platform: NodeJS.Platform = process.platform): PromptContent {
  if (!Array.isArray(blocks)) throw new RpcFailure(RPC.invalidParams, "prompt must be a list of content blocks");
  const parts: string[] = [];
  const images = new Map<number, RuntimeImage>();
  const notes: string[] = [];
  let limited = false;

  /** A picture's base64, as an image block or a blob; false when it is not one (the caller decides then). */
  const picture = (data: unknown, declared: unknown, blob: boolean): boolean => {
    const said = typeof declared === "string" && oneLine(declared, 60) ? ` (${oneLine(declared, 60)})` : "";
    const plain = typeof data === "string" ? data.replace(/\s+/g, "") : "";
    if (!plain || !BASE64.test(plain) || plain.length % 4 === 1) {
      if (blob) return false;
      notes.push("A picture sent with the request could not be read; it was not attached.");
      return true;
    }
    const mimeType = sniff(plain);
    const tooBig = base64Bytes(plain) > MAX_IMAGE_BYTES;
    const overNote = () => { notes.push(`A picture sent with the request is over ${MAX_IMAGE_BYTES / 1024 / 1024} MB; it was not attached.`); return true; };
    // An image block says it is a picture, so its size is said first; a blob is one only when its bytes say so.
    if (tooBig && !blob) return overNote();
    if (!mimeType) {
      if (blob) return false;
      notes.push(`A picture sent with the request is not a PNG, JPEG, GIF or WebP${said}; it was not attached.`);
      return true;
    }
    if (tooBig) return overNote();
    if (images.size >= MAX_IMAGES) { limited = true; return true; }
    const bytes = Buffer.from(plain, "base64");
    const number = images.size + 1;
    images.set(number, { data: bytes.toString("base64"), mimeType: imageMimeType(bytes) ?? mimeType });
    parts.push(imageLabel(number));
    return true;
  };

  for (const block of blocks as Json[]) {
    const type = block && typeof block === "object" ? block.type : undefined;
    if (type === "text" && typeof block.text === "string") { parts.push(block.text); continue; }
    if (type === "image") { picture(block.data, block.mimeType, false); continue; }
    if (type === "resource_link" && typeof block.uri === "string") {
      const file = linkedFile(block.uri, platform);
      const size = typeof block.size === "number" && Number.isFinite(block.size) && block.size >= 0 ? block.size : undefined;
      if (file) parts.push(fileLine(file, block.name, size, platform));
      else {
        const name = typeof block.name === "string" ? oneLine(block.name) : "";
        parts.push(name && name !== block.uri ? `${name} ${block.uri}` : block.uri);
      }
      continue;
    }
    const resource = type === "resource" && block.resource && typeof block.resource === "object" ? block.resource as Json : undefined;
    if (resource && typeof resource.uri === "string") {
      const uri = resource.uri;
      const file = linkedFile(uri, platform);
      if (typeof resource.text === "string") {
        const size = Buffer.byteLength(resource.text);
        if (size <= MAX_EMBEDDED_TEXT) parts.push(`${uri}\n${resource.text}`);
        else if (file) parts.push(fileLine(file, undefined, size, platform));
        else {
          // Cut at a line, so the model never reads half of one.
          const head = Buffer.from(resource.text).subarray(0, MAX_EMBEDDED_TEXT).toString("utf8");
          const end = head.lastIndexOf("\n");
          parts.push(`${uri}\n${end > 0 ? head.slice(0, end) : head.replace(/\uFFFD$/, "")}`);
          notes.push(`The text sent as ${oneLine(uri)} is over ${MAX_EMBEDDED_TEXT / 1024} KB; only its first ${MAX_EMBEDDED_TEXT / 1024} KB went with the request.`);
        }
        continue;
      }
      if (typeof resource.blob === "string") {
        if (picture(resource.blob, resource.mimeType, true)) continue;
        if (file) parts.push(fileLine(file, undefined, base64Bytes(resource.blob.replace(/\s+/g, "")), platform));
        else notes.push(`${oneLine(uri)} is not text or a picture Casper can read; it was not sent.`);
        continue;
      }
      parts.push(file ? fileLine(file, undefined, undefined, platform) : uri);
      continue;
    }
    if (type === "audio") { notes.push("Casper takes no audio; the recording was not sent."); continue; }
    const named = typeof type === "string" && oneLine(type, 40) ? `a ${oneLine(type, 40)} block` : "a block with no type";
    notes.push(`Casper can't read ${named}; it was not sent.`);
  }
  if (limited) notes.push(`Only ${MAX_IMAGES} pictures go with one request; the rest were not attached.`);
  const text = parts.join("\n").trim();
  if (!text) throw new RpcFailure(RPC.invalidParams, ["Nothing in the prompt Casper can read.", ...notes].join("\n"));
  return { text, images, notes };
}
