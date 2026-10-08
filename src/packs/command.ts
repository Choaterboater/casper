import { realpath, rm } from "node:fs/promises";
import path from "node:path";
import { within } from "../platform/project-paths";
import { tildePath } from "../new/scaffold";
import { allBundledSkills } from "../skills/bundled";
import { packChanges, readPackFolder, shownLine, shownText, type PackContents } from "./files";
import { fetchGitPack, isGitSource, parseGitSource, type GitFetchOptions, type GitPackSource } from "./git";
import { PackError } from "./manifest";
import { clearStaleStaging, installPack, loadInstalledPacks, removePack, stagePack, type InstalledPack, type PackRecord } from "./store";
import { packThemeOwner, registerPackThemes } from "./themes";
import { activeThemeName, BUILT_IN_THEMES } from "../tui/theme";

/**
 * /pack add, /pack list and /pack remove. Typed by you only: the AI has no tool that reaches them, and a run that
 * can't ask you adds nothing. Every word of the add box is Casper's own, counted from the files themselves; the
 * pack's own text appears only quoted as the author's, or in full when you pick "Show me what's inside", with
 * terminal escapes, controls and bidi characters taken out. Nothing is updated on its own: adding again is the update.
 */

export const PACK_USAGE = "Usage: /pack add <folder or https://github.com/owner/repo@commit> | /pack list | /pack remove <name>";
/** No first, so Enter adds nothing. */
export const PACK_ADD_CHOICES = ["No", "Yes, add it", "Show me what's inside"] as const;
export const PACK_CANT_ASK = "Adding a pack asks you first, and this run can't ask. Nothing was added.";
export const PACKS_OFF = "Packs are off (packs: off in ~/.casper/config.yaml). /settings turns them on.";

export interface PackHost {
  homeDir: string;
  /** Where a relative folder is found: the session's folder. */
  cwd: string;
  /** False with `packs: off`. */
  packsOn: boolean;
  /** Someone can answer the box now (never a one-shot run). */
  canAsk: boolean;
  print(line: string): void;
  /** One box only you answer: the chosen label, or undefined (Esc, nobody answered). */
  approve(preview: string, question: string, choices: readonly string[]): Promise<string | undefined>;
  /** Every skill Casper indexed (with its pack, for a pack's own) and every MCP server name. */
  takenNames(): { skills: Array<{ name: string; source: string; pack?: string }>; servers: string[] };
  /** Index skills again, so a pack added or removed counts from the next request. */
  reload?(): Promise<void>;
  git?: GitFetchOptions;
  platform?: NodeJS.Platform;
}

/** Where a pack came from, as you would type it again, and as it is shown. */
interface Source { stored: string; shown: string; same: (stored: string) => boolean }

/** The same repository counts as the same source, whatever the commit: adding it again is how a pack is updated. */
function gitSource(text: string): Source & { fetch: GitPackSource } {
  const parsed = parseGitSource(text);
  return {
    fetch: parsed, stored: parsed.text, shown: parsed.shown,
    same: (other) => { try { return parseGitSource(other).repo === parsed.repo; } catch { return false; } },
  };
}

/** A recorded source as a line: "github.com/x/y at 1234567890ab", or the folder. */
export function describeSource(stored: string, home: string, platform: NodeJS.Platform = process.platform): string {
  if (isGitSource(stored)) {
    try { const parsed = parseGitSource(stored); return `${parsed.shown} at ${parsed.commit.slice(0, 12)}`; }
    catch { return shownLine(stored); }
  }
  return shownLine(tildePath(stored, home, platform));
}

function count(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} bytes` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export interface PackBox { preview: string; question: string; inside: string }

/** The add box, computed by Casper from the files: never read from the manifest's own words, except the author's line,
 * quoted and named as theirs. `before` is the record of the same pack added earlier from the same source. */
export function packBox(contents: PackContents, shownSource: string, before?: PackRecord): PackBox {
  const { manifest, files, skills } = contents;
  const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const changes = before ? packChanges(before.files, files) : undefined;
  const changed = new Set([...(changes?.changed ?? []), ...(changes?.added ?? [])]);
  const lines = [
    `Pack ${manifest.name} ${before && before.version !== manifest.version ? `${shownLine(before.version)} → ` : ""}${manifest.version} from ${shownSource}`,
    `The author says: "${shownLine(manifest.description)}"`,
    `Skills: ${skills.map((skill) => skill.name).join(", ")}`,
    ...(contents.theme && manifest.theme ? [`Theme: ${contents.theme.name} (${manifest.theme}), colours only. It is used only if you pick it in /settings.`] : []),
    `Files: ${files.length}, ${size(bytes)} in all. Casper reads them as text; the AI gets a skill's text only when a request fits it.`,
    ...(changes ? [
      ...(changes.changed.length ? [`Changed since you added it: ${changes.changed.join(", ")}`] : []),
      ...(changes.added.length ? [`New: ${changes.added.join(", ")}`] : []),
      ...(changes.removed.length ? [`Gone: ${changes.removed.join(", ")}`] : []),
    ] : []),
  ];
  // Every line of a file sits behind a bar, so no line in it can pass for Casper's own header between files.
  const inside = files.map((file) => [
    `--- ${file.path} (${size(file.bytes)}${changed.has(file.path) && before ? ", changed" : ""}) ---`,
    ...shownText(file.text).replace(/\n+$/, "").split("\n").map((line) => `  │ ${line}`.trimEnd()),
  ].join("\n")).join("\n\n");
  return {
    preview: `${lines.join("\n")}\n`,
    question: `Add pack ${manifest.name}${before ? " again" : ""} from ${shownSource}?\nIt brings ${count(skills.length, "skill")}${contents.theme ? " and a theme" : ""}. Nothing else runs.`,
    inside: `${inside}\n--- end of pack ${manifest.name} ---\n`,
  };
}

/** A name the pack would take that something else has: its own name or a skill's. Built-in names stay Casper's. */
function nameClash(contents: PackContents, host: PackHost, otherPacks: readonly string[]): string | undefined {
  const { manifest, skills } = contents;
  const taken = host.takenNames();
  const owners = new Map<string, string>();
  for (const name of otherPacks) owners.set(name, `pack ${name}`);
  for (const server of taken.servers) owners.set(server, `the MCP server ${server}`);
  for (const skill of taken.skills) if (skill.pack !== manifest.name) owners.set(skill.name, skill.pack ? `a skill of pack ${skill.pack}` : `a ${skill.source} skill`);
  for (const skill of allBundledSkills()) owners.set(skill.metadata.name, "a skill built into Casper");
  for (const name of [manifest.name, ...skills.map((skill) => skill.name)]) {
    const owner = owners.get(name);
    if (owner) return `Pack ${manifest.name} can't be added: the name ${name} is already used by ${owner}. Nothing was added.`;
  }
  return undefined;
}

/** A theme name another theme has: a built-in one's, or the theme of another pack you added. */
function themeClash(contents: PackContents, others: readonly InstalledPack[]): string | undefined {
  const { manifest, theme } = contents;
  if (!theme) return undefined;
  const pack = others.find((other) => other.record.name !== manifest.name && other.theme?.name === theme.name)?.record.name;
  const owner = BUILT_IN_THEMES.some((builtIn) => builtIn.name === theme.name) ? "a theme built into Casper" : pack ? `the theme of pack ${pack}` : undefined;
  if (!owner) return undefined;
  return `Pack ${manifest.name} can't be added: its theme is named ${theme.name}, and that name is already used by ${owner}. Nothing was added.`;
}

async function folderSource(text: string, host: PackHost): Promise<Source & { dir: string }> {
  const typed = text.startsWith("~/") || text.startsWith("~\\") ? path.join(host.homeDir, text.slice(2)) : text === "~" ? host.homeDir : text;
  const dir = await realpath(path.resolve(host.cwd, typed)).catch(() => undefined);
  if (!dir) throw new PackError(`There is no folder ${shownLine(text)}.`);
  if (within(await realpath(path.join(host.homeDir, ".casper")).catch(() => path.join(host.homeDir, ".casper")), dir)) {
    throw new PackError("That folder is Casper's own. Add a pack from the folder you downloaded it to.");
  }
  return { dir, stored: dir, shown: describeSource(dir, host.homeDir, host.platform), same: (other) => other === dir };
}

async function addPack(host: PackHost, text: string): Promise<void> {
  if (!host.packsOn) throw new PackError(PACKS_OFF);
  if (!host.canAsk) throw new PackError(PACK_CANT_ASK);
  const typed = text.trim().replace(/^(["'])(.*)\1$/, "$2");
  if (!typed) { host.print(PACK_USAGE); return; }
  await clearStaleStaging(host.homeDir);
  let source: Source;
  let contents: PackContents;
  if (isGitSource(typed)) {
    const git = gitSource(typed);
    source = git;
    host.print(`Fetching ${git.shown} at commit ${git.fetch.commit.slice(0, 12)} (up to 2 minutes; Ctrl+C stops it)…`);
    contents = await fetchGitPack(git.fetch, host.git);
  } else {
    const folder = await folderSource(typed, host);
    source = folder;
    contents = await readPackFolder(folder.dir);
  }
  const installed = await loadInstalledPacks(host.homeDir);
  const { name } = contents.manifest;
  if (installed.rejected.includes(name)) throw new PackError(`Pack ${name}'s record doesn't check out. /pack remove ${name} clears it; then add it again.`);
  const before = installed.packs.find((pack) => pack.record.name === name);
  if (before && !source.same(before.record.source)) {
    throw new PackError(`A pack named ${name} is already added, from ${describeSource(before.record.source, host.homeDir, host.platform)}. /pack remove ${name} first, then add this one.`);
  }
  const clash = nameClash(contents, host, [...installed.packs.map((pack) => pack.record.name), ...installed.rejected].filter((other) => other !== name));
  if (clash) throw new PackError(clash);
  const themeTaken = themeClash(contents, installed.packs);
  if (themeTaken) throw new PackError(themeTaken);
  if (before && !before.problem && before.record.source === source.stored) {
    const changes = packChanges(before.record.files, contents.files);
    if (!changes.added.length && !changes.changed.length && !changes.removed.length) {
      host.print(`Pack ${name} is already added, and nothing changed. Nothing was added.`);
      return;
    }
  }
  const staged = await stagePack(host.homeDir, contents);
  let added = false;
  try {
    const box = packBox(staged.contents, source.shown, before?.record);
    let answer = await host.approve(box.preview, box.question, PACK_ADD_CHOICES);
    if (answer === PACK_ADD_CHOICES[2]) {
      host.print(box.inside);
      answer = await host.approve("", box.question, PACK_ADD_CHOICES.slice(0, 2));
    }
    if (answer !== PACK_ADD_CHOICES[1]) { host.print(`Pack ${name} was not added.`); return; }
    await installPack(host.homeDir, staged, source.stored);
    added = true;
  } finally {
    if (!added) await rm(staged.dir, { recursive: true, force: true }).catch(() => undefined);
  }
  await host.reload?.();
  const notes = await registerPackThemes(host.homeDir, host.packsOn);
  const skills = staged.contents.skills.map((skill) => skill.name).join(", ");
  const theme = staged.contents.theme ? ` Its theme ${staged.contents.theme.name} is in /settings → Theme.` : "";
  host.print(`Added pack ${name} ${staged.contents.manifest.version}: ${skills}. Casper uses ${staged.contents.skills.length === 1 ? "it" : "them"} when a request fits.${theme} /pack remove ${name} takes it out.`);
  for (const note of notes) host.print(`[pack] ${note}`);
}

async function listPacks(host: PackHost): Promise<void> {
  const { packs, rejected } = await loadInstalledPacks(host.homeDir);
  const lines: string[] = [];
  if (!host.packsOn) lines.push(PACKS_OFF);
  for (const { record, problem } of packs) {
    const where = describeSource(record.source, host.homeDir, host.platform);
    lines.push(problem
      ? `  ${record.name} ${shownLine(record.version)} · not used: ${problem}. /pack add ${shownLine(record.source)} shows it again.`
      : `  ${record.name} ${shownLine(record.version)} · ${count(record.skills.length, "skill")}${record.theme ? " and a theme" : ""} · from ${where} · added ${record.addedAt.slice(0, 10)}`);
  }
  for (const name of rejected) lines.push(`  ${name} · not used: its record doesn't check out. /pack remove ${name} clears it.`);
  if (!packs.length && !rejected.length) lines.push("No packs yet. /pack add <folder or https://github.com/owner/repo@commit> adds one.");
  host.print(lines.join("\n"));
}

async function removeNamed(host: PackHost, name: string): Promise<void> {
  // Its theme on screen now stays until Casper starts again; then theme: no longer finds it and default is used.
  const inUse = packThemeOwner(activeThemeName()) === name ? activeThemeName() : undefined;
  if (!(await removePack(host.homeDir, name))) { host.print(`No pack named ${shownLine(name)}. /pack list shows yours.`); return; }
  await host.reload?.();
  await registerPackThemes(host.homeDir, host.packsOn);
  host.print(`Removed pack ${name}.${inUse ? ` Its theme ${inUse} stays on screen until you start Casper again; then the colours go back to default.` : ""}`);
}

/** "/pack …" with what follows the command word. */
export async function runPackCommand(host: PackHost, argument: string): Promise<void> {
  const [action = "", ...rest] = argument.trim().split(/\s+/);
  const remainder = argument.trim().slice(action.length).trim();
  try {
    if ((action === "list" || action === "") && !rest.length) await listPacks(host);
    else if (action === "add" && remainder) await addPack(host, remainder);
    else if (action === "remove" && rest.length === 1) await removeNamed(host, rest[0]!);
    else host.print(PACK_USAGE);
  } catch (error) {
    if (error instanceof PackError) { host.print(`[pack] ${error.message}`); return; }
    throw error;
  }
}
