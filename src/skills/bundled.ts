import { rmSync } from "node:fs";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProjectModel } from "../project/model";
import type { TaskClassification } from "../task/classify";
import { normaliseLineEndings, parseSkillMetadata, splitSkill, type SkillMetadata } from "./metadata";
import aoscxSource from "../../skills/network/aoscx/SKILL.md" with { type: "text" };
import centralClassicSource from "../../skills/network/central-classic/SKILL.md" with { type: "text" };
import centralSource from "../../skills/network/central/SKILL.md" with { type: "text" };
import clearpassSource from "../../skills/network/clearpass/SKILL.md" with { type: "text" };
import junosSource from "../../skills/network/junos/SKILL.md" with { type: "text" };
import mistSource from "../../skills/network/mist/SKILL.md" with { type: "text" };
import dockerSource from "../../skills/homelab/docker/SKILL.md" with { type: "text" };
import mediaSource from "../../skills/homelab/media/SKILL.md" with { type: "text" };
import nettroubleSource from "../../skills/homelab/nettrouble/SKILL.md" with { type: "text" };
import proxmoxSource from "../../skills/homelab/proxmox/SKILL.md" with { type: "text" };
import frontendSource from "../../skills/web/frontend/SKILL.md" with { type: "text" };
import illustrationKit from "../../skills/web/frontend/illustration-kit.svg" with { type: "text" };

/** A bundled skill rides along with one request, so it stays small (about 1,500 tokens). */
export const MAX_BUNDLED_BODY_BYTES = 6 * 1024;
export const MAX_BUNDLED_DESCRIPTION = 200;
/** At most this many bundled skills go into one request (about 12 KiB). */
export const MAX_BUNDLED_ACTIVE = 2;

export const NETWORK_PLATFORMS = ["mist", "central", "central-classic", "aoscx", "junos", "clearpass"] as const;
export type NetworkPlatform = typeof NETWORK_PLATFORMS[number];
export const HOMELAB_PLATFORMS = ["media", "docker", "proxmox", "nettrouble"] as const;
export type HomelabPlatform = typeof HOMELAB_PLATFORMS[number];
/** A bundled skill family with triggers: its name starts with `<family>-` and it lives in skills/<family>/. */
export type SkillFamily = "network" | "homelab";
export type SkillPlatform = NetworkPlatform | HomelabPlatform;

export function platformFamily(platform: SkillPlatform): SkillFamily {
  return (HOMELAB_PLATFORMS as readonly string[]).includes(platform) ? "homelab" : "network";
}

/** Every network skill has these sections, in this order. */
export const REQUIRED_SECTIONS = [
  "## When to use",
  "## Sign-in and tokens",
  "## Read first",
  "## Changing things (Casper asks)",
  "## Paging and rate limits",
  "## Common traps",
  "## Testing with saved sample data",
  "## Public docs",
] as const;
export const CHANGING_SECTION = "## Changing things (Casper asks)";
/** Every home lab skill has these sections, in this order. */
export const HOMELAB_SECTIONS = ["## When to use", "## Read first", CHANGING_SECTION, "## Common traps", "## Public docs"] as const;

export function sectionsFor(family: SkillFamily): readonly string[] {
  return family === "homelab" ? HOMELAB_SECTIONS : REQUIRED_SECTIONS;
}
/** The first line of "Changing things". A skill that replaces a bundled one must keep it. */
export const STOP_AND_ASK_LINE = "MCP: Casper's change box asks; don't ask again in chat. Else ask the user first; show the exact call.";
export const CASPER_ASKS_LINE = "Casper also asks before a shell command reaches a new host.";

/** Words a skill must never use: they promise more than a skill can know. */
export const BANNED_PHRASES = [
  "secure", "securely", "guarantee", "guaranteed", "read-only", "readonly", "read only",
  "safe to run", "harmless", "cannot change", "won't change",
] as const;

/** A weak trigger picks a skill only with one of these words in the same request. */
export const CONTEXT_WORDS = [
  "api", "sdk", "rest", "org", "site", "sites", "ap", "aps", "switch", "switches", "gateway", "gateways",
  "wlan", "ssid", "device", "devices", "inventory", "token", "webhook", "clients", "vlan", "vlans",
  "python", "script", "netconf", "rpc", "playbook", "endpoint", "endpoints",
] as const;

/** Too common to pick a skill on their own. "central" may be a weak trigger, never a strong one. */
export const BANNED_TRIGGER_WORDS = [
  ...CONTEXT_WORDS, "central", "network", "router", "config", "configuration", "cloud", "wifi",
  "wireless", "aruba", "juniper", "hpe",
] as const;
/** Home lab words too common to pick a skill. "docker", "qm" and "pct" may be weak triggers, never strong ones. */
export const HOMELAB_BANNED_TRIGGER_WORDS = [
  ...BANNED_TRIGGER_WORDS, "docker", "compose", "container", "containers", "image", "images", "media", "server", "servers",
  "stack", "stacks", "vm", "vms", "lxc", "backup", "backups", "storage", "cluster", "node", "nodes", "vpn", "download",
  "downloads", "downloader", "torrent", "torrents", "home lab", "homelab", "restart", "update", "snapshot", "qm", "pct",
] as const;
/** A weak home lab trigger picks a skill only with one of these words, unless its block names its own `triggers.context`. */
export const HOMELAB_CONTEXT_WORDS = ["home lab", "homelab", "self hosted", "selfhosted"] as const;
const WEAK_ONLY_TRIGGERS = new Set(["central"]);
const HOMELAB_WEAK_ONLY_TRIGGERS = new Set(["docker", "qm", "pct"]);

/** The intents for which a project's SDK counts as a reason to pick a skill. */
const FRAMEWORK_INTENTS = new Set(["implement", "fix", "test", "configure"]);

export interface BundledSkillRule {
  platform: SkillPlatform;
  family: SkillFamily;
  strong: string[];
  weak: string[];
  /** Words one of which a weak trigger needs in the same request; empty means the family's own list. */
  context: string[];
  /** Phrases that rule the skill out ("classic central" for the new Central skill). */
  unless: string[];
  frameworks: string[];
  version: number;
}

export interface BundledSkill {
  kind?: "network";
  metadata: SkillMetadata;
  rule: BundledSkillRule;
  /** Frontmatter text, as the registry keeps it for other skills. */
  header: string;
  body: string;
  /** The whole file, for its digest. */
  source: string;
  /** Where the file lives in Casper's repository; a bundled skill has no directory on disk. */
  path: string;
}

/** Lowercase, keep runs of letters, digits and dots, and drop dots at the ends of words. */
export function normaliseWords(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9.]+/)
    .map((word) => word.replace(/^\.+|\.+$/g, ""))
    .filter(Boolean);
}

function phrase(text: string): string {
  return normaliseWords(text).join(" ");
}

function stringList(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim())) {
    throw new Error(`${label} must be a list of words`);
  }
  return value.map((item: string) => phrase(item)).filter(Boolean);
}

/** The `casper-skill` block. It also works in a user's own skill that copies it. */
export function parseSkillRule(value: unknown, name: string): BundledSkillRule {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} has no casper-skill block`);
  const fields = value as Record<string, unknown>;
  const platform = fields.platform;
  const platforms: readonly string[] = [...NETWORK_PLATFORMS, ...HOMELAB_PLATFORMS];
  if (typeof platform !== "string" || !platforms.includes(platform)) {
    throw new Error(`${name}: casper-skill.platform must be one of ${platforms.join(", ")}`);
  }
  const family = platformFamily(platform as SkillPlatform);
  const triggers = fields.triggers;
  if (!triggers || typeof triggers !== "object" || Array.isArray(triggers)) throw new Error(`${name}: casper-skill.triggers must be a mapping`);
  const { strong: strongValue, weak: weakValue, unless: unlessValue, context: contextValue } = triggers as Record<string, unknown>;
  const strong = stringList(strongValue, `${name}: casper-skill.triggers.strong`);
  const weak = stringList(weakValue, `${name}: casper-skill.triggers.weak`);
  const unless = stringList(unlessValue, `${name}: casper-skill.triggers.unless`);
  const context = stringList(contextValue, `${name}: casper-skill.triggers.context`);
  if (!strong.length) throw new Error(`${name}: casper-skill.triggers.strong needs at least one trigger`);
  const banned = new Set<string>(family === "homelab" ? HOMELAB_BANNED_TRIGGER_WORDS : BANNED_TRIGGER_WORDS);
  const weakOnlyWords = family === "homelab" ? HOMELAB_WEAK_ONLY_TRIGGERS : WEAK_ONLY_TRIGGERS;
  for (const trigger of [...strong, ...weak]) {
    const weakOnly = weak.includes(trigger) && !strong.includes(trigger) && weakOnlyWords.has(trigger);
    if (banned.has(trigger) && !weakOnly) throw new Error(`${name}: "${trigger}" is too common to be a trigger`);
  }
  const frameworks = stringList(fields.frameworks, `${name}: casper-skill.frameworks`);
  const version = fields.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) throw new Error(`${name}: casper-skill.version must be a whole number from 1`);
  return { platform: platform as SkillPlatform, family, strong, weak, context, unless, frameworks, version };
}

function sectionText(body: string, heading: string): string | undefined {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^## /.test(line));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

/** What a network or home lab skill body must keep: its family's sections in order, the stop-and-ask line, no
 * overclaiming words. Used for bundled skills and for a user skill that replaces one. An empty list means it is kept. */
export function safetyProblems(body: string, family: SkillFamily = "network"): string[] {
  const problems: string[] = [];
  const sections = sectionsFor(family);
  const headings = body.split(/\r?\n/).filter((line) => /^## /.test(line)).map((line) => line.trim());
  if (JSON.stringify(headings) !== JSON.stringify(sections)) {
    problems.push(`sections must be exactly: ${sections.map((heading) => heading.slice(3)).join(" / ")}`);
  }
  const changing = sectionText(body, CHANGING_SECTION);
  const opening = changing?.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) ?? [];
  if (opening[0] !== STOP_AND_ASK_LINE) problems.push(`"${CHANGING_SECTION.slice(3)}" must open with: ${STOP_AND_ASK_LINE}`);
  if (!opening.slice(0, 3).includes(CASPER_ASKS_LINE)) problems.push(`"${CHANGING_SECTION.slice(3)}" must say: ${CASPER_ASKS_LINE}`);
  const lower = body.toLowerCase();
  for (const word of BANNED_PHRASES) {
    if (new RegExp(`(^|[^a-z])${word.replace(/[-]/g, "[-]")}([^a-z]|$)`).test(lower)) problems.push(`uses "${word}"`);
  }
  return problems;
}

/** Parse and check one bundled skill. A broken bundled skill is a build error, so this throws. */
export function parseBundledSkill(text: string, filePath: string): BundledSkill {
  const source = normaliseLineEndings(text);
  const { header, body } = splitSkill(source);
  const metadata = parseSkillMetadata(header);
  if (!/^(?:network|homelab)-/.test(metadata.name)) throw new Error(`${filePath}: a bundled network skill's name starts with network-, a home lab skill's with homelab-`);
  if (metadata.disableModelInvocation) throw new Error(`${metadata.name}: a bundled skill is picked by its triggers; remove disable-model-invocation`);
  if (metadata.description.length > MAX_BUNDLED_DESCRIPTION || /\n/.test(metadata.description)) {
    throw new Error(`${metadata.name}: the description is one line of at most ${MAX_BUNDLED_DESCRIPTION} characters`);
  }
  if (Buffer.byteLength(body) > MAX_BUNDLED_BODY_BYTES) throw new Error(`${metadata.name}: the body is larger than 6 KiB`);
  const rule = parseSkillRule(metadata.extra["casper-skill"], metadata.name);
  if (!metadata.name.startsWith(`${rule.family}-`)) throw new Error(`${metadata.name}: a ${rule.platform} skill's name starts with ${rule.family}-`);
  const problems = safetyProblems(body, rule.family);
  if (problems.length) throw new Error(`${metadata.name}: ${problems.join("; ")}`);
  return { metadata, rule, header, body, source, path: filePath };
}

const BUNDLED_SOURCES: Array<[string, string]> = [
  [aoscxSource, "skills/network/aoscx/SKILL.md"],
  [centralSource, "skills/network/central/SKILL.md"],
  [centralClassicSource, "skills/network/central-classic/SKILL.md"],
  [clearpassSource, "skills/network/clearpass/SKILL.md"],
  [junosSource, "skills/network/junos/SKILL.md"],
  [mistSource, "skills/network/mist/SKILL.md"],
];

let cached: BundledSkill[] | undefined;

/** The network skills shipped inside Casper. Their text is in the binary; picking reads no file. */
export function bundledSkills(): BundledSkill[] {
  cached ??= BUNDLED_SOURCES.map(([source, filePath]) => parseBundledSkill(source, filePath));
  return cached;
}

const HOMELAB_SOURCES: Array<[string, string]> = [
  [dockerSource, "skills/homelab/docker/SKILL.md"],
  [mediaSource, "skills/homelab/media/SKILL.md"],
  [nettroubleSource, "skills/homelab/nettrouble/SKILL.md"],
  [proxmoxSource, "skills/homelab/proxmox/SKILL.md"],
];

let cachedHomelab: BundledSkill[] | undefined;

/** The home lab skills shipped inside Casper: picked and checked the same way as the network skills. */
export function homelabSkills(): BundledSkill[] {
  cachedHomelab ??= HOMELAB_SOURCES.map(([source, filePath]) => parseBundledSkill(source, filePath));
  return cachedHomelab;
}

function contains(words: string, trigger: string): boolean {
  return ` ${words} `.includes(` ${trigger} `);
}

/** Local word match, no model call. A subject trigger is required: strong 6 each, weak with a
 * context word 3. The project's SDK boosts a matching change request with context by 2. */
export function scoreSkillRule(
  rule: BundledSkillRule,
  request: string,
  project: Pick<ProjectModel, "frameworks">,
  classification: Pick<TaskClassification, "intent">,
): number {
  const words = normaliseWords(request);
  const text = words.join(" ");
  if (rule.unless.some((phraseText) => contains(text, phraseText))) return 0;
  const strong = rule.strong.filter((trigger) => contains(text, trigger)).length;
  const weak = rule.weak.filter((trigger) => contains(text, trigger));
  // A trigger's own words never count as its context ("api gateway" is not a weak hit plus "api").
  const triggerWords = new Set([...rule.strong, ...weak].flatMap((trigger) => trigger.split(" ")));
  const contextWords: readonly string[] = rule.context.length ? rule.context
    : rule.family === "homelab" ? HOMELAB_CONTEXT_WORDS : CONTEXT_WORDS;
  const context = contextWords.some((word) => !triggerWords.has(word) && contains(text, word));
  const weakHit = weak.length > 0 && context;
  const frameworkHit = context && FRAMEWORK_INTENTS.has(classification.intent)
    && rule.frameworks.some((framework) => project.frameworks.includes(framework));
  // The stack describes the project, not this request's subject. Generic words such as
  // "script" or "token" must not load a device skill for unrelated work in that project.
  if (!strong && !weakHit) return 0;
  return strong * 6 + (weakHit ? 3 : 0) + (frameworkHit ? 2 : 0);
}

/**
 * Bundled web skills (skills/web/<name>/SKILL.md): guidance for building UI, not rules about devices. They are
 * picked by scoreWebSkill, never by network triggers, and carry no stop-and-ask wording.
 */
export interface BundledWebSkill {
  kind: "web";
  metadata: SkillMetadata;
  header: string;
  body: string;
  source: string;
  path: string;
  /** Files the body points to by name, read by the AI only when it needs one (never part of the prompt). */
  files: Record<string, string>;
}

export type AnyBundledSkill = BundledSkill | BundledWebSkill;

/** Parse and check one bundled web skill. A broken one is a build error, so this throws. */
export function parseWebSkill(text: string, filePath: string, files: Record<string, string> = {}): BundledWebSkill {
  const source = normaliseLineEndings(text);
  const { header, body } = splitSkill(source);
  const metadata = parseSkillMetadata(header);
  if (!metadata.name.startsWith("web-")) throw new Error(`${filePath}: a bundled web skill's name starts with web-`);
  if (metadata.description.length > MAX_BUNDLED_DESCRIPTION || /\n/.test(metadata.description)) {
    throw new Error(`${metadata.name}: the description is one line of at most ${MAX_BUNDLED_DESCRIPTION} characters`);
  }
  if (Buffer.byteLength(body) > MAX_BUNDLED_BODY_BYTES) throw new Error(`${metadata.name}: the body is larger than 6 KiB`);
  return { kind: "web", metadata, header, body, source, path: filePath, files };
}

let cachedWeb: BundledWebSkill[] | undefined;

/** The web skills shipped inside Casper (today: web-frontend). */
export function webSkills(): BundledWebSkill[] {
  cachedWeb ??= [parseWebSkill(frontendSource, "skills/web/frontend/SKILL.md", { "illustration-kit.svg": illustrationKit })];
  return cachedWeb;
}

const skillFolders = new Map<string, Promise<string | undefined>>();

/** A folder holding a bundled skill's files, so the AI's read tool can open them: made once per run in a new
 * temporary folder only this user can open, and removed when Casper exits. Undefined when the skill has no files or
 * the folder could not be made. */
export function bundledSkillFolder(skill: BundledWebSkill): Promise<string | undefined> {
  if (!Object.keys(skill.files).length) return Promise.resolve(undefined);
  let folder = skillFolders.get(skill.metadata.name);
  if (!folder) {
    folder = (async () => {
      const made = await mkdtemp(path.join(os.tmpdir(), `casper-${skill.metadata.name}-`));
      // "exit" runs only synchronous work.
      process.once("exit", () => { try { rmSync(made, { recursive: true, force: true }); } catch {} });
      await chmod(made, 0o700);
      for (const [name, text] of Object.entries(skill.files)) await writeFile(path.join(made, name), text, { flag: "wx" });
      return made;
    })().catch(() => undefined);
    skillFolders.set(skill.metadata.name, folder);
  }
  return folder;
}

/** Words that make a request UI work in any project. Matched as whole words or phrases after normaliseWords. */
const UI_WORDS = [
  "ui", "user interface", "frontend", "front end", "web page", "webpage", "web pages", "landing page", "homepage", "home page",
  "website", "web site", "web app", "webapp", "css", "stylesheet", "html", "navbar", "nav bar", "dark mode", "look and feel",
] as const;

/** Words that also mean other things (a CSV header, an API page, a VLAN design, a log style): UI work only in a web project. */
const WEB_PROJECT_WORDS = [
  "page", "pages", "layout", "style", "styles", "styling", "button", "buttons", "form", "forms", "menu", "modal", "dialog",
  "sidebar", "header", "footer", "component", "components", "screen", "theme", "responsive", "design",
] as const;

/** Frameworks that make a project a web app. */
const WEB_FRAMEWORKS = ["react", "next", "vue", "nuxt", "svelte", "sveltekit", "angular", "vite", "electron", "tauri", "django", "flask"];

/** Requests that ask about the UI rather than change it. */
const QUESTION_INTENTS = new Set(["inspect", "document", "visualize"]);

/** A styling system the project already uses: then the repo's look wins. */
const STYLING_FRAMEWORKS = ["tailwind", "styled-components", "emotion"];

/** The frontend skill's pick: UI work (not a question about it), in a project with no styles, components, design
 * folder or styling package yet. A plain web word counts anywhere; a word with other meanings counts only in a
 * project with a web framework. 6 when picked, else 0. A local word match, no model call. */
export function scoreWebSkill(
  request: string,
  project: Pick<ProjectModel, "architecture" | "frameworks">,
  classification: Pick<TaskClassification, "intent">,
): number {
  if (QUESTION_INTENTS.has(classification.intent)) return 0;
  const { ui, styles, design } = project.architecture;
  if (ui || styles || design || project.frameworks.some((framework) => STYLING_FRAMEWORKS.includes(framework))) return 0;
  const text = normaliseWords(request).join(" ");
  if (UI_WORDS.some((word) => contains(text, word))) return 6;
  const web = project.frameworks.some((framework) => WEB_FRAMEWORKS.includes(framework));
  return web && WEB_PROJECT_WORDS.some((word) => contains(text, word)) ? 6 : 0;
}

/** Every bundled skill: the network pack, the home lab skills and the web skills. */
export function allBundledSkills(): AnyBundledSkill[] {
  return [...bundledSkills(), ...homelabSkills(), ...webSkills()];
}

/** One bundled skill's score for a request, by its kind. */
export function scoreBundledSkill(
  skill: AnyBundledSkill,
  request: string,
  project: Pick<ProjectModel, "architecture" | "frameworks">,
  classification: Pick<TaskClassification, "intent">,
): number {
  return skill.kind === "web" ? scoreWebSkill(request, project, classification) : scoreSkillRule(skill.rule, request, project, classification);
}
