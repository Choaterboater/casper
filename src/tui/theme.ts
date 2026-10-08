/** The parts of Casper's screen a theme colours. A theme sets colours only: bold, italics, glyphs, words and layout
 * stay Casper's, and no colour ever reaches the model.
 * accent: the prompt, headings, links, Casper's boxes and the wordmark. muted: hints, the footer, secondary text.
 * border: rules, the input box and code block lines. selection: the highlighted choice in a list or question.
 * success, warning, error: ✓, • and ✗ lines, a result's edge and boxes of that kind. diffAdded, diffRemoved, diffHunk:
 * a diff's + and - lines and its @@ headers. */
export const THEME_ROLES = ["accent", "muted", "border", "selection", "success", "warning", "error", "diffAdded", "diffRemoved", "diffHunk"] as const;
export type ThemeRole = typeof THEME_ROLES[number];

/** The colour names a theme may use, as the terminal's own palette draws them (so a light or dark terminal keeps
 * its look), with their SGR codes. `default` is the terminal's own text colour and `dim` that colour faint. */
const NAMED_COLORS: Readonly<Record<string, string>> = {
  default: "", dim: "2",
  black: "30", red: "31", green: "32", yellow: "33", blue: "34", magenta: "35", cyan: "36", white: "37",
  gray: "90", "bright-red": "91", "bright-green": "92", "bright-yellow": "93", "bright-blue": "94", "bright-magenta": "95",
  "bright-cyan": "96", "bright-white": "97",
};
export const COLOR_NAMES: readonly string[] = Object.keys(NAMED_COLORS);
const HEX_COLOR = /^#[0-9a-f]{6}$/;

/** A colour: one of COLOR_NAMES, or #rrggbb (lower case). */
export type ThemeColor = string;

export interface Theme {
  readonly name: string;
  readonly colors: Readonly<Record<ThemeRole, ThemeColor>>;
}

/** The same rule as a skill's name: 1–64 lowercase letters, numbers or single hyphens. */
export function isThemeName(name: unknown): name is string {
  return typeof name === "string" && name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}

export function isThemeColor(value: unknown): value is ThemeColor {
  return typeof value === "string" && (Object.hasOwn(NAMED_COLORS, value) || HEX_COLOR.test(value));
}

/** Casper's own look: cyan for structure, faint for what is secondary. */
export const DEFAULT_THEME: Theme = Object.freeze({ name: "default", colors: Object.freeze({
  accent: "cyan", muted: "dim", border: "dim", selection: "cyan", success: "green", warning: "yellow", error: "red",
  diffAdded: "green", diffRemoved: "red", diffHunk: "cyan",
}) });

/** For a light terminal background: blue instead of cyan, magenta instead of yellow, which wash out on white. */
const LIGHT_THEME: Theme = Object.freeze({ name: "light", colors: Object.freeze({
  accent: "blue", muted: "dim", border: "dim", selection: "blue", success: "green", warning: "magenta", error: "red",
  diffAdded: "green", diffRemoved: "red", diffHunk: "blue",
}) });

/** Bright colours and no faint text: secondary text at the terminal's full strength. */
const HIGH_CONTRAST_THEME: Theme = Object.freeze({ name: "high-contrast", colors: Object.freeze({
  accent: "bright-cyan", muted: "default", border: "default", selection: "bright-yellow", success: "bright-green",
  warning: "bright-yellow", error: "bright-red", diffAdded: "bright-green", diffRemoved: "bright-red", diffHunk: "bright-cyan",
}) });

export const BUILT_IN_THEMES: readonly Theme[] = [DEFAULT_THEME, LIGHT_THEME, HIGH_CONTRAST_THEME];

const themes = new Map<string, Theme>(BUILT_IN_THEMES.map(theme => [theme.name, theme]));

/**
 * Add a theme (a pack's, read with parseThemeFile) to the list /settings offers and `theme:` can name. Its colours
 * are checked again and copied, so a theme made in code is held to the file's rules. A name already taken (a built-in
 * one too) is refused: a theme never replaces another. Register before Casper starts, so `theme:` finds it.
 */
export function registerTheme(theme: Theme): void {
  if (!isThemeName(theme.name)) throw new Error("a theme's name must be 1–64 lowercase letters, numbers or single hyphens");
  if (themes.has(theme.name)) throw new Error(`there is already a theme named ${theme.name}`);
  if (typeof theme.colors !== "object" || theme.colors === null) throw new Error(`theme ${theme.name}: colors must be a mapping of roles to colours`);
  const colors = {} as Record<ThemeRole, ThemeColor>;
  for (const role of THEME_ROLES) {
    const value = Object.hasOwn(theme.colors, role) ? theme.colors[role] : undefined;
    if (!isThemeColor(value)) throw new Error(`theme ${theme.name}: ${role} must be #rrggbb or one of ${COLOR_NAMES.join(", ")}`);
    colors[role] = value;
  }
  themes.set(theme.name, Object.freeze({ name: theme.name, colors: Object.freeze(colors) }));
}

/** Take a registered theme off the list (a pack removed). Built-in themes stay; one in use stays in use until set again. */
export function unregisterTheme(name: string): boolean {
  if (BUILT_IN_THEMES.some(theme => theme.name === name)) return false;
  return themes.delete(name);
}

/** Every theme by name: the built-in ones first, then registered ones in the order they came. */
export function themeNames(): string[] { return [...themes.keys()]; }

export function findTheme(name: string): Theme | undefined { return themes.get(name); }

/** The one line Casper says (at start, and in casper doctor) when `theme:` names no theme it has. */
export function themeNote(name: string | undefined): string | undefined {
  if (name === undefined || themes.has(name)) return undefined;
  const names = themeNames();
  return `theme ${shownThemeName(name)} is not one Casper has; using default. Themes: ${names.join(", ")}`;
}

/** A `theme:` value as written, on one short line, to name it back to you. */
export function shownThemeName(name: string): string { return name.replace(/\s+/g, " ").slice(0, 64); }

/** 24-bit colour where the terminal says it draws it (COLORTERM, or Windows Terminal); else the nearest of 256. */
function trueColor(env: Record<string, string | undefined>): boolean {
  return /^(?:truecolor|24bit)$/i.test(env.COLORTERM ?? "") || Boolean(env.WT_SESSION);
}

/** The 256-colour palette's 6×6×6 cube and its grey ramp: the nearest entry to an #rrggbb colour. */
function nearest256(red: number, green: number, blue: number): number {
  const step = (value: number) => value < 48 ? 0 : value < 115 ? 1 : Math.min(5, Math.floor((value - 35) / 40));
  const level = (index: number) => index ? 55 + index * 40 : 0;
  const [r, g, b] = [step(red), step(green), step(blue)];
  const average = Math.round((red + green + blue) / 3);
  const grey = Math.max(0, Math.min(23, Math.round((average - 8) / 10)));
  const distance = (x: number, y: number, z: number) => (x - red) ** 2 + (y - green) ** 2 + (z - blue) ** 2;
  const cube = distance(level(r), level(g), level(b));
  const greyLevel = 8 + grey * 10;
  return distance(greyLevel, greyLevel, greyLevel) < cube ? 232 + grey : 16 + 36 * r + 6 * g + b;
}

/** The SGR parameters for one colour ("36", "2", "38;2;r;g;b"); "" for the terminal's own text colour. */
export function colorCode(color: ThemeColor, env: Record<string, string | undefined> = process.env): string {
  if (Object.hasOwn(NAMED_COLORS, color)) return NAMED_COLORS[color]!;
  if (!HEX_COLOR.test(color)) return "";
  const [red, green, blue] = [1, 3, 5].map(at => parseInt(color.slice(at, at + 2), 16)) as [number, number, number];
  return trueColor(env) ? `38;2;${red};${green};${blue}` : `38;5;${nearest256(red, green, blue)}`;
}

function codesFor(theme: Theme, env: Record<string, string | undefined>): Record<ThemeRole, string> {
  return Object.fromEntries(THEME_ROLES.map(role => [role, colorCode(theme.colors[role], env)])) as Record<ThemeRole, string>;
}

let activeName = DEFAULT_THEME.name;
let activeCodes = codesFor(DEFAULT_THEME, process.env);

/** Use the theme with this name from now on; an unknown name (or none) uses default. True when the name was found.
 * Whether colour shows at all (NO_COLOR, a pipe, TERM=dumb) is the terminal's choice, not the theme's. */
export function useTheme(name: string | undefined, env: Record<string, string | undefined> = process.env): boolean {
  const theme = (name === undefined ? undefined : themes.get(name));
  activeName = (theme ?? DEFAULT_THEME).name;
  activeCodes = codesFor(theme ?? DEFAULT_THEME, env);
  return theme !== undefined;
}

/** The name of the theme in use. */
export function activeThemeName(): string { return activeName; }

/** The SGR parameters for a role in the theme in use; "" when the role takes the terminal's own text colour. */
export function roleCode(role: ThemeRole): string { return activeCodes[role]; }
