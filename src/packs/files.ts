import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { openNoFollow } from "../platform/files";
import { isOutside } from "../platform/inside";
import { parseSkillMetadata, splitSkill } from "../skills/metadata";
import type { Theme } from "../tui/theme";
import { parseThemeFile } from "../tui/theme-file";
import { isPackPath, MANIFEST_FILE, MAX_PACK_FOLDERS, packPathRefusal, PackError, parseManifest, type PackManifest } from "./manifest";

/**
 * What is in a pack folder, read the one way Casper reads every pack: from a folder you named, from a fetched
 * commit, from the staging copy before you are asked, and from ~/.casper/packs when Casper starts. Plain text files
 * only, no links, nothing outside the folder, within the limits, and nothing the manifest doesn't list.
 *
 * Listed means: pack.yaml itself, a README.md or LICENSE (LICENSE.md, LICENSE.txt) at the top, the one theme file
 * pack.yaml names, or any file inside a skill folder it names (a skill's own notes and examples are part of it). Any
 * other file refuses the pack.
 */

export const PACK_LIMITS = { files: 200, fileBytes: 256 * 1024, totalBytes: 2 * 1024 * 1024, depth: MAX_PACK_FOLDERS } as const;

const TOP_EXTRAS = new Set(["README.md", "LICENSE", "LICENSE.md", "LICENSE.txt"]);
/** Never read, copied or shown: a git checkout's own folder at the top, and the folder notes macOS and Windows leave. */
const SKIPPED_TOP = new Set([".git"]);
export const SKIPPED_ANYWHERE: ReadonlySet<string> = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

export interface PackFile { path: string; text: string; sha256: string; bytes: number }
export interface PackSkill { folder: string; name: string; description: string }
export interface PackContents {
  manifest: PackManifest;
  files: PackFile[];
  skills: PackSkill[];
  /** The theme file pack.yaml names, read with the strict theme-file parser: colours only. */
  theme?: Theme;
}

/** Characters a person can't see but the AI reads: controls, format characters (bidi, zero-width, the tag block),
 * every character Unicode says draws nothing (variation selectors, the grapheme joiner, Mongolian and Khmer marks,
 * blank fillers) and the blank Braille cell. */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u{2800}]/gu;
/** Kept in a pack's text: tab, newline and carriage return. */
const ALLOWED = new Set(["\t", "\n", "\r"]);
/** The two invisible characters an emoji is written with, only where they are part of one: the emoji selector right
 * after a pictograph (or in a keycap like #️⃣), and the joiner between two pictographs (👩‍💻). Anywhere else, or one
 * after another, they would carry text nobody sees. */
const EMOJI_PART = /(?<=\p{Extended_Pictographic}[\u{1F3FB}-\u{1F3FF}]?)\u{FE0F}|(?<=[0-9#*])\u{FE0F}(?=\u{20E3})|(?<=\p{Extended_Pictographic}\u{FE0F}?[\u{1F3FB}-\u{1F3FF}]?)\u{200D}(?=\p{Extended_Pictographic})/gu;
const HIDDEN_OR_EMOJI_PART = new RegExp(`(${EMOJI_PART.source})|${HIDDEN.source}`, "gu");

function hiddenCharacter(text: string): string | undefined {
  for (const [character] of text.replace(EMOJI_PART, "").matchAll(HIDDEN)) if (!ALLOWED.has(character)) return character;
  return undefined;
}

/** Text from a pack as it may be shown: terminal escapes, controls, bidi and invisible characters taken out; an
 * emoji keeps its own joiner and selector, so it shows as written. */
export function shownText(text: string): string {
  return stripVTControlCharacters(text).replace(HIDDEN_OR_EMOJI_PART, (character, emoji?: string) => emoji || character === "\n" || character === "\t" ? character : "");
}

/** One line of pack text as it may be shown. */
export function shownLine(text: string): string {
  return shownText(text).replace(/\s+/g, " ").trim();
}

/** Keeps a leading byte-order mark, so the text written back is the same bytes. */
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function packFile(relative: string, bytes: Uint8Array): PackFile {
  let text: string;
  try { text = decoder.decode(bytes); } catch { throw new PackError(`${relative} is not a text file. A pack holds text only.`); }
  const hidden = hiddenCharacter(text.replace(/^\uFEFF/, ""));
  if (hidden) {
    const code = `U+${hidden.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
    throw new PackError(`${relative} has a character you can't see (${code}). Casper doesn't add text you can't read in full.`);
  }
  return { path: relative, text, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}

async function readNoFollow(file: string, maxBytes: number): Promise<Uint8Array> {
  const handle = await openNoFollow(file);
  try {
    if (!(await handle.stat()).isFile()) throw new PackError("not a plain file");
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) throw new PackError("too large");
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

/** Reads and checks a pack folder. Throws a PackError that says what is wrong; reads nothing outside `root`. */
export async function readPackFolder(root: string): Promise<PackContents> {
  const top = await realpath(root).catch(() => undefined);
  if (!top || !(await lstat(top)).isDirectory()) throw new PackError("That folder isn't there.");
  const files: PackFile[] = [];
  const seen = new Set<string>();
  let total = 0;
  const walk = async (dir: string, relative: string, depth: number): Promise<void> => {
    if (depth > PACK_LIMITS.depth) throw new PackError(`${relative} is more than ${PACK_LIMITS.depth} folders deep.`);
    for (const name of (await readdir(dir)).sort()) {
      if ((!relative && SKIPPED_TOP.has(name)) || SKIPPED_ANYWHERE.has(name)) continue;
      const inside = relative ? `${relative}/${name}` : name;
      if (!isPackPath(inside)) throw new PackError(packPathRefusal(inside, JSON.stringify(shownLine(inside))));
      // Two names that differ only in case would be one file on Windows and macOS.
      if (seen.has(inside.toLowerCase())) throw new PackError(`${inside} is there twice, in different case.`);
      seen.add(inside.toLowerCase());
      const full = path.join(dir, name);
      const details = await lstat(full);
      if (details.isSymbolicLink()) throw new PackError(`${inside} is a link. A pack holds plain files only.`);
      if (details.isDirectory()) { await walk(full, inside, depth + 1); continue; }
      if (!details.isFile()) throw new PackError(`${inside} is not a plain file.`);
      if (files.length >= PACK_LIMITS.files) throw new PackError(`The pack has more than ${PACK_LIMITS.files} files.`);
      if (details.size > PACK_LIMITS.fileBytes) throw new PackError(`${inside} is larger than ${PACK_LIMITS.fileBytes / 1024} KB.`);
      // The real path stays inside the folder: a folder swapped for a link while this reads is caught here.
      if (isOutside(path.relative(top, await realpath(full)))) throw new PackError(`${inside} leads outside the pack.`);
      let bytes: Uint8Array;
      try { bytes = await readNoFollow(full, PACK_LIMITS.fileBytes); }
      catch (error) { throw error instanceof PackError ? new PackError(`${inside}: ${error.message}.`) : error; }
      total += bytes.length;
      if (total > PACK_LIMITS.totalBytes) throw new PackError(`The pack is larger than ${PACK_LIMITS.totalBytes / 1024 / 1024} MB.`);
      files.push(packFile(inside, bytes));
    }
  };
  await walk(top, "", 0);
  return checkPack(files);
}

/** The manifest, and every file accounted for by it: refuses an unlisted file, a listed folder with no SKILL.md, two
 * skills with one name, and a theme file that isn't there or doesn't read as a theme. */
export function checkPack(files: readonly PackFile[]): PackContents {
  const manifestFile = files.find((file) => file.path === MANIFEST_FILE);
  if (!manifestFile) throw new PackError(`There is no ${MANIFEST_FILE} at the top of the pack.`);
  const manifest = parseManifest(manifestFile.text);
  for (const file of files) {
    if (file.path === MANIFEST_FILE || TOP_EXTRAS.has(file.path) || file.path === manifest.theme) continue;
    if (!manifest.skills.some((folder) => file.path.startsWith(`${folder}/`))) {
      throw new PackError(`${file.path} is not listed in ${MANIFEST_FILE} (it isn't inside a listed skill folder${manifest.theme ? " or the theme" : ""}). Casper adds only what a pack lists.`);
    }
  }
  const skills = manifest.skills.map((folder): PackSkill => {
    const file = files.find((candidate) => candidate.path === `${folder}/SKILL.md`);
    if (!file) throw new PackError(`${folder} is listed in ${MANIFEST_FILE} but has no SKILL.md.`);
    try {
      const metadata = parseSkillMetadata(splitSkill(file.text).header);
      return { folder, name: metadata.name, description: metadata.description };
    } catch (error) {
      throw new PackError(`${folder}/SKILL.md: ${error instanceof Error ? error.message : String(error)}.`);
    }
  });
  const names = new Set<string>();
  for (const { name } of skills) {
    if (names.has(name)) throw new PackError(`Two skills in the pack are named ${name}.`);
    names.add(name);
  }
  const theme = manifest.theme === undefined ? undefined : packTheme(files, manifest.theme);
  return { manifest, files: [...files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0), skills, ...(theme ? { theme } : {}) };
}

/** The theme file pack.yaml names, as the theme-file parser reads it: one plain reason when it isn't one. A leading
 * byte-order mark (Windows editors write one) is left out, as it is for every other file of a pack; one anywhere
 * else is still refused. */
function packTheme(files: readonly PackFile[], relative: string): Theme {
  const file = files.find((candidate) => candidate.path === relative);
  if (!file) throw new PackError(`The theme ${relative} is listed in ${MANIFEST_FILE} but isn't in the pack.`);
  const read = parseThemeFile(file.text.replace(/^\uFEFF/, ""));
  if ("error" in read) throw new PackError(`The theme ${relative} can't be used: ${read.error}.`);
  return read.theme;
}

/** The file fingerprints a record keeps: path to sha256. */
export function fingerprints(files: readonly PackFile[]): Record<string, string> {
  return Object.fromEntries(files.map((file) => [file.path, file.sha256]));
}

/** What changed between the files you added before and these. */
export function packChanges(before: Readonly<Record<string, string>>, after: readonly PackFile[]): { added: string[]; changed: string[]; removed: string[] } {
  const now = fingerprints(after);
  return {
    added: Object.keys(now).filter((file) => !Object.hasOwn(before, file)),
    changed: Object.keys(now).filter((file) => Object.hasOwn(before, file) && before[file] !== now[file]),
    removed: Object.keys(before).filter((file) => !Object.hasOwn(now, file)),
  };
}
