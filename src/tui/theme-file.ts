import { isAlias, parseAllDocuments, visit } from "yaml";
import { COLOR_NAMES, DEFAULT_THEME, isThemeColor, isThemeName, THEME_ROLES, type Theme, type ThemeColor, type ThemeRole } from "./theme";

/** A theme file is a few lines; anything bigger is not one. */
export const MAX_THEME_FILE_BYTES = 8 * 1024;

/** Control characters (tab and a lone carriage return too), C1 controls, bidi overrides and backslashes: a theme
 * file needs none of them, so it can't carry an escape sequence, even one spelled out for YAML to decode. */
const UNSAFE = /[\x00-\x09\x0b-\x1f\x7f-\x9f​-‏‪-‮⁦-⁩﻿\\]/;

const FIELDS = ["name", "colors"];

export type ThemeFileResult = { theme: Theme } | { error: string };

/**
 * A theme file (YAML or JSON, as a pack carries it) read strictly: colours only, no code. It holds `name` (the same
 * rule as a skill's name) and `colors`, a mapping from the roles in THEME_ROLES to #rrggbb or a name in COLOR_NAMES.
 * A role left out takes the default theme's colour. Anything else is refused with one plain reason: another field,
 * another role, another value, a file over 8 KiB, a control character or escape anywhere, YAML anchors, aliases and
 * tags (no theme builds on another or pulls in a file). The theme is not added anywhere: see registerTheme.
 */
export function parseThemeFile(text: string): ThemeFileResult {
  if (typeof text !== "string") return { error: "a theme file must be text" };
  if (Buffer.byteLength(text, "utf8") > MAX_THEME_FILE_BYTES) return { error: `a theme file must be at most ${MAX_THEME_FILE_BYTES / 1024} KiB` };
  const source = text.replace(/\r\n/g, "\n");
  const unsafe = UNSAFE.exec(source);
  if (unsafe) return { error: `a theme file can't hold ${unsafe[0] === "\\" ? "a backslash" : `the character U+${unsafe[0].codePointAt(0)!.toString(16).padStart(4, "0").toUpperCase()}`}` };
  const documents = parseAllDocuments(source, { uniqueKeys: true, merge: false, schema: "core", logLevel: "silent" });
  if (!Array.isArray(documents) || documents.length > 1) return { error: "not valid YAML or JSON: a theme file is one document" };
  const document = documents[0];
  if (!document) return { error: "a theme file must be a mapping with name and colors" };
  if (document.errors.length) return { error: `not valid YAML or JSON: ${document.errors[0]!.message.split("\n")[0]!.replace(/ at line \d+, column \d+:?$/, "")}` };
  // YAML that builds on itself (an anchor and its aliases) or names a type (a tag) is not a theme file.
  let reused = false;
  visit(document, { Node: (_key, node) => { if (isAlias(node) || node.anchor || node.tag) { reused = true; return visit.BREAK; } return undefined; } });
  if (reused) return { error: "a theme file can't use YAML anchors, aliases or tags" };
  let value: unknown;
  try { value = document.toJS({ maxAliasCount: 0 }); }
  catch (error) { return { error: `not valid YAML or JSON: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}` }; }
  if (!isPlainMapping(value)) return { error: "a theme file must be a mapping with name and colors" };
  const unknown = Object.keys(value).find(key => !FIELDS.includes(key));
  if (unknown !== undefined) return { error: `unknown field ${shown(unknown)}; a theme file has only name and colors` };
  if (!isThemeName(value.name)) return { error: "name must be 1–64 lowercase letters, numbers or single hyphens" };
  if (!Object.hasOwn(value, "colors")) return { error: "colors is missing" };
  if (!isPlainMapping(value.colors)) return { error: "colors must be a mapping of roles to colours" };
  const colors: Record<ThemeRole, ThemeColor> = { ...DEFAULT_THEME.colors };
  for (const [role, color] of Object.entries(value.colors)) {
    if (!THEME_ROLES.some(known => known === role)) return { error: `unknown role ${shown(role)}; roles are ${THEME_ROLES.join(", ")}` };
    // YAML reads an unquoted #rrggbb as a comment, which leaves the value empty.
    if (color === null) return { error: `${role} has no colour (put a #rrggbb colour in quotes: "#3366ff")` };
    const lower = typeof color === "string" ? color.toLowerCase() : color;
    if (!isThemeColor(lower)) return { error: `${role} must be #rrggbb or one of ${COLOR_NAMES.join(", ")}` };
    colors[role as ThemeRole] = lower;
  }
  return { theme: Object.freeze({ name: value.name, colors: Object.freeze(colors) }) };
}

/** A mapping made by the parser: a plain object, not an array, a date or anything with its own prototype. */
function isPlainMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

/** A key from the file, short and on one line, for an error message. */
function shown(key: string): string {
  return JSON.stringify(key.length > 40 ? `${key.slice(0, 40)}…` : key);
}
