/**
 * A typed line that only asks to save this conversation ("export this session", "save the chat to my desktop as a
 * md", "explort this session as well in a md and save to desktop"): Casper runs /export itself, with no model call,
 * as it does for "change model to opus 5.5" (src/app/model-words.ts). The line is read only when the person typed all
 * of it and the whole line is that request; "export the CSV function", "how do I export a model" or "save the session
 * token" go to the AI as before.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { CasperApp } from "../app";
import { knownFolder, type KnownFolderName } from "../platform/known-folders";
import { terminalText } from "../tui/format";
import { exportFolder } from "./peer-commands";

export interface ExportWords {
  /** A folder named in words: the Desktop, Documents or Downloads. */
  folder?: KnownFolderName;
  /** A file named in the words (notes.md, ~/x/chat.jsonl), in the folder when one is named too. */
  file?: string;
  /** Every message (.jsonl) rather than the Markdown. */
  jsonl: boolean;
}

// The verb, with the typos people make in it ("explort").
const VERB = String.raw`(?:export|explort|exprot|expot|exort|exoprt|epxort|exprt|exportt|save|dump|write\s+out|download)`;
// Please, "can you", or Casper's name before it.
const POLITE = String.raw`(?:(?:please|pls|casper|hey\s+casper)[,\s]+)*(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?`;
// This conversation, by any of its names: at least one of this/the/our…, so "export session data" isn't one.
const OBJECT = String.raw`(?:a\s+copy\s+of\s+)?(?:(?:this|the|our|my|current|whole|full|entire|complete)\s+)+(?:session|conversation|convo|chat|transcript)(?:\s+(?:history|log|transcript))?`;
const HEAD = new RegExp(String.raw`^${POLITE}${VERB}\s+(?:out\s+)?${OBJECT}(?=[\s,]|$)`, "i");

// What may follow, in any order; anything else and the line is not this request.
const FILLER = /^(?:,|(?:and|then|also|too|as\s+well|please|now|for\s+me|(?:save|keep)\s+it|(?:as|to|into)\s+a\s+file)(?=[\s,]|$))/i;
const FORMAT = /^(?:as|in|into|to)\s+(?:an?\s+)?(\.?md|markdown|\.?jsonl|json\s*lines)(?:\s+(?:file|format))?(?=[\s,]|$)/i;
const PLACE = /^(?:(?:save|put|write|store|drop|place|copy|send)\s+(?:it\s+|that\s+)?)?(?:to|on|onto|in|into|at)\s+(?:my\s+|the\s+)?(desktop|documents|docs|downloads?)(?:\s+folder)?(?=[\s,]|$)/i;
const FILE = /^(?:(?:save|put|write|store)\s+(?:it\s+)?)?(?:to|as|in|into|at|called|named)\s+(?:a\s+file\s+(?:called|named)\s+)?(["'`]?)([^\s"'`]+\.(?:md|markdown|jsonl))\1(?=[\s,]|$)/i;
const FOLDERS: Record<string, KnownFolderName> = { desktop: "desktop", documents: "documents", docs: "documents", downloads: "downloads", download: "downloads" };

/** What a typed line asks to save, or undefined when the line is anything else. `pasted`: text pasted into the line;
 * a line with any never counts. */
export function exportRequest(line: string, pasted: readonly string[] = []): ExportWords | undefined {
  if (pasted.some(Boolean) || line.length > 160 || /[\r\n]/.test(line.trim())) return undefined;
  const text = line.trim().replace(/\s*[.!?]+$/, "");
  const head = HEAD.exec(text);
  if (!head) return undefined;
  const words: ExportWords = { jsonl: false };
  let rest = text.slice(head[0].length).trimStart();
  while (rest) {
    let match: RegExpExecArray | null;
    if ((match = FORMAT.exec(rest))) words.jsonl = /jsonl|json\s*lines/i.test(match[1]!);
    else if ((match = PLACE.exec(rest))) {
      if (words.folder) return undefined;
      words.folder = FOLDERS[match[1]!.toLowerCase()];
    } else if ((match = FILE.exec(rest))) {
      if (words.file) return undefined;
      words.file = match[2]!;
      words.jsonl = /\.jsonl$/i.test(words.file);
    } else if (!(match = FILLER.exec(rest))) return undefined;
    rest = rest.slice(match[0].length).trimStart();
  }
  // A folder and a file with its own path: two places, so not a plain request.
  if (words.folder && words.file && /[\\/]/.test(words.file)) return undefined;
  return words;
}

/** The /export line the words ask for: a folder's path from `folderPath`, a ~ at the start of a file is your home.
 * With a folder and no file name, the name /export gives (`casper-conversation-<id>`). */
export async function exportLine(words: ExportWords, options: {
  home: string; sessionId?: string; exportFolder: string; folderPath: (name: KnownFolderName) => Promise<string>;
}): Promise<string> {
  const ext = words.jsonl ? "jsonl" : "md";
  const name = `casper-conversation${options.sessionId ? `-${options.sessionId.slice(0, 8)}` : ""}.${ext}`;
  const file = words.file && /^~[\\/]/.test(words.file) ? path.join(options.home, words.file.slice(2)) : words.file;
  if (words.folder) return `/export ${path.join(await options.folderPath(words.folder), file ?? name)}`;
  if (file) return `/export ${file}`;
  if (!words.jsonl) return "/export";
  // Every message, in /export's own folder: it makes that folder only when no file is named, so it is made here.
  await mkdir(options.exportFolder, { recursive: true, mode: 0o700 });
  return `/export ${path.join(options.exportFolder, name)}`;
}

/** The one line that says Casper saved it itself. */
export const exportHandledHere = (line: string) => `[export] Handled here, no model call: ${terminalText(line)} does the same.\n`;

/** The /export line for the words in this app: its home, this conversation's ID and the person's known folders. */
export function exportWordsLine(app: Pick<CasperApp, "homeDir" | "session" | "knownFolder">, words: ExportWords): Promise<string> {
  const home = app.homeDir();
  let sessionId: string | undefined;
  try { sessionId = app.session?.getSessionInfo?.().sessionId; } catch { sessionId = undefined; }
  return exportLine(words, { home, ...(sessionId ? { sessionId } : {}), exportFolder: exportFolder(home),
    folderPath: (name) => app.knownFolder ? app.knownFolder(name) : knownFolder(name, { home }) });
}
