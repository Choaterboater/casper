import { parse } from "yaml";
import { SKILL_NAME } from "../skills/metadata";

/**
 * A pack's pack.yaml: its name, version, a line from its author, and the skill folders it brings. Nothing else is
 * read, and anything else is refused rather than skipped: a pack written for a later Casper must not install here
 * with part of it quietly left out. A new field goes in FIELDS and is read in parseManifest, nowhere else.
 */

/** Why a pack can't be added, in plain words for the person; nothing was installed. */
export class PackError extends Error {}

export const MANIFEST_FILE = "pack.yaml";
export const MAX_PACK_SKILLS = 64;

export interface PackManifest {
  name: string;
  version: string;
  /** The author's own words. Shown quoted, as the author's, never as Casper's. */
  description: string;
  /** Skill folders, relative to the pack (skills/drafting). Each holds a SKILL.md. */
  skills: string[];
}

const FIELDS = ["name", "version", "description", "skills"] as const;
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,32})?$/;
/** One part of a path inside a pack: letters, digits, dot, dash, underscore and space, starting with a letter or digit.
 * No "..", no hidden names, nothing a terminal or another system reads differently. */
const PART = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,99}$/;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/i;

/** A relative path inside a pack, with forward slashes: every part plain, none "." or "..", no trailing dot or space. */
export function isPackPath(relative: string): boolean {
  if (!relative || relative.length > 400 || relative.startsWith("/") || relative.includes("\\")) return false;
  const parts = relative.split("/");
  return parts.length <= 8 && parts.every((part) => PART.test(part) && !/[. ]$/.test(part) && !WINDOWS_RESERVED.test(part));
}

export function parseManifest(text: string): PackManifest {
  let value: unknown;
  try { value = parse(text, { maxAliasCount: 0, uniqueKeys: true }); }
  catch { throw new PackError(`${MANIFEST_FILE} is not valid YAML.`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PackError(`${MANIFEST_FILE} must be a list of fields (name, version, description, skills).`);
  const fields = value as Record<string, unknown>;
  const unknown = Object.keys(fields).filter((key) => !(FIELDS as readonly string[]).includes(key));
  if (unknown.length) throw new PackError(`${MANIFEST_FILE} has ${unknown.length === 1 ? "a field" : "fields"} Casper doesn't take: ${unknown.slice(0, 5).map((key) => JSON.stringify(key)).join(", ")}. A pack has only name, version, description and skills.`);
  const { name, version, description, skills } = fields;
  if (typeof name !== "string" || name.length > 64 || !SKILL_NAME.test(name)) {
    throw new PackError(`${MANIFEST_FILE}: name must be 1-64 lowercase letters, numbers or single hyphens.`);
  }
  // The name is a folder in ~/.casper/packs: a name Windows keeps for a device is refused on every system, so a pack
  // that adds on one adds on all.
  if (WINDOWS_RESERVED.test(name)) throw new PackError(`${MANIFEST_FILE}: the name ${name} is one Windows keeps for itself (like con or nul). Pick another.`);
  if (typeof version !== "string" || !VERSION.test(version)) throw new PackError(`${MANIFEST_FILE}: version must look like 1.2.0.`);
  if (typeof description !== "string" || !description.trim() || description.length > 300) {
    throw new PackError(`${MANIFEST_FILE}: description must be 1-300 characters.`);
  }
  if (!Array.isArray(skills) || !skills.length || skills.length > MAX_PACK_SKILLS || !skills.every((entry): entry is string => typeof entry === "string")) {
    throw new PackError(`${MANIFEST_FILE}: skills must list 1-${MAX_PACK_SKILLS} skill folders.`);
  }
  const folders = skills.map((entry) => entry.replace(/\/+$/, ""));
  for (const folder of folders) {
    if (!isPackPath(folder)) throw new PackError(`${MANIFEST_FILE}: ${JSON.stringify(folder)} is not a plain folder inside the pack.`);
  }
  // One listed folder inside another would make a file belong to two skills.
  for (const folder of folders) {
    const inside = folders.find((other) => other !== folder && (folder === other || folder.startsWith(`${other}/`)));
    if (inside) throw new PackError(`${MANIFEST_FILE}: ${folder} is inside ${inside}; list each skill folder once.`);
  }
  if (new Set(folders.map((folder) => folder.toLowerCase())).size !== folders.length) throw new PackError(`${MANIFEST_FILE}: a skill folder is listed twice.`);
  return { name, version, description: description.trim(), skills: folders };
}
