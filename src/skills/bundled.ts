import type { ProjectModel } from "../project/model";
import type { TaskClassification } from "../task/classify";
import { normaliseLineEndings, parseSkillMetadata, splitSkill, type SkillMetadata } from "./metadata";
import aoscxSource from "../../skills/network/aoscx/SKILL.md" with { type: "text" };
import centralClassicSource from "../../skills/network/central-classic/SKILL.md" with { type: "text" };
import centralSource from "../../skills/network/central/SKILL.md" with { type: "text" };
import clearpassSource from "../../skills/network/clearpass/SKILL.md" with { type: "text" };
import junosSource from "../../skills/network/junos/SKILL.md" with { type: "text" };
import mistSource from "../../skills/network/mist/SKILL.md" with { type: "text" };
import frontendSource from "../../skills/web/frontend/SKILL.md" with { type: "text" };

/** A bundled skill rides along with one request, so it stays small (about 1,500 tokens). */
export const MAX_BUNDLED_BODY_BYTES = 6 * 1024;
export const MAX_BUNDLED_DESCRIPTION = 200;
/** At most this many bundled skills go into one request (about 12 KiB). */
export const MAX_BUNDLED_ACTIVE = 2;

export const NETWORK_PLATFORMS = ["mist", "central", "central-classic", "aoscx", "junos", "clearpass"] as const;
export type NetworkPlatform = typeof NETWORK_PLATFORMS[number];

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
const WEAK_ONLY_TRIGGERS = new Set(["central"]);

/** The intents for which a project's SDK counts as a reason to pick a skill. */
const FRAMEWORK_INTENTS = new Set(["implement", "fix", "test", "configure"]);

export interface BundledSkillRule {
  platform: NetworkPlatform;
  strong: string[];
  weak: string[];
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
  if (typeof platform !== "string" || !NETWORK_PLATFORMS.includes(platform as NetworkPlatform)) {
    throw new Error(`${name}: casper-skill.platform must be one of ${NETWORK_PLATFORMS.join(", ")}`);
  }
  const triggers = fields.triggers;
  if (!triggers || typeof triggers !== "object" || Array.isArray(triggers)) throw new Error(`${name}: casper-skill.triggers must be a mapping`);
  const { strong: strongValue, weak: weakValue, unless: unlessValue } = triggers as Record<string, unknown>;
  const strong = stringList(strongValue, `${name}: casper-skill.triggers.strong`);
  const weak = stringList(weakValue, `${name}: casper-skill.triggers.weak`);
  const unless = stringList(unlessValue, `${name}: casper-skill.triggers.unless`);
  if (!strong.length) throw new Error(`${name}: casper-skill.triggers.strong needs at least one trigger`);
  const banned = new Set<string>(BANNED_TRIGGER_WORDS);
  for (const trigger of [...strong, ...weak]) {
    const weakOnly = weak.includes(trigger) && !strong.includes(trigger) && WEAK_ONLY_TRIGGERS.has(trigger);
    if (banned.has(trigger) && !weakOnly) throw new Error(`${name}: "${trigger}" is too common to be a trigger`);
  }
  const frameworks = stringList(fields.frameworks, `${name}: casper-skill.frameworks`);
  const version = fields.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) throw new Error(`${name}: casper-skill.version must be a whole number from 1`);
  return { platform: platform as NetworkPlatform, strong, weak, unless, frameworks, version };
}

function sectionText(body: string, heading: string): string | undefined {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^## /.test(line));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

/** What a network skill body must keep: the sections in order, the stop-and-ask line, no overclaiming
 * words. Used for bundled skills and for a user skill that replaces one. An empty list means it is kept. */
export function safetyProblems(body: string): string[] {
  const problems: string[] = [];
  const headings = body.split(/\r?\n/).filter((line) => /^## /.test(line)).map((line) => line.trim());
  if (JSON.stringify(headings) !== JSON.stringify(REQUIRED_SECTIONS)) {
    problems.push(`sections must be exactly: ${REQUIRED_SECTIONS.map((heading) => heading.slice(3)).join(" / ")}`);
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
  if (!metadata.name.startsWith("network-")) throw new Error(`${filePath}: a bundled network skill's name starts with network-`);
  if (metadata.disableModelInvocation) throw new Error(`${metadata.name}: a bundled skill is picked by its triggers; remove disable-model-invocation`);
  if (metadata.description.length > MAX_BUNDLED_DESCRIPTION || /\n/.test(metadata.description)) {
    throw new Error(`${metadata.name}: the description is one line of at most ${MAX_BUNDLED_DESCRIPTION} characters`);
  }
  if (Buffer.byteLength(body) > MAX_BUNDLED_BODY_BYTES) throw new Error(`${metadata.name}: the body is larger than 6 KiB`);
  const rule = parseSkillRule(metadata.extra["casper-skill"], metadata.name);
  const problems = safetyProblems(body);
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

function contains(words: string, trigger: string): boolean {
  return ` ${words} `.includes(` ${trigger} `);
}

/** Local word match, no model call. 0 means not picked. Strong trigger 6 each, weak trigger with a
 * context word 3, the project's SDK plus a change request plus a context word 2. */
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
  const context = words.some((word) => !triggerWords.has(word) && (CONTEXT_WORDS as readonly string[]).includes(word));
  const weakHit = weak.length > 0 && context;
  const frameworkHit = context && FRAMEWORK_INTENTS.has(classification.intent)
    && rule.frameworks.some((framework) => project.frameworks.includes(framework));
  if (!strong && !weakHit && !frameworkHit) return 0;
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
}

export type AnyBundledSkill = BundledSkill | BundledWebSkill;

/** Parse and check one bundled web skill. A broken one is a build error, so this throws. */
export function parseWebSkill(text: string, filePath: string): BundledWebSkill {
  const source = normaliseLineEndings(text);
  const { header, body } = splitSkill(source);
  const metadata = parseSkillMetadata(header);
  if (!metadata.name.startsWith("web-")) throw new Error(`${filePath}: a bundled web skill's name starts with web-`);
  if (metadata.description.length > MAX_BUNDLED_DESCRIPTION || /\n/.test(metadata.description)) {
    throw new Error(`${metadata.name}: the description is one line of at most ${MAX_BUNDLED_DESCRIPTION} characters`);
  }
  if (Buffer.byteLength(body) > MAX_BUNDLED_BODY_BYTES) throw new Error(`${metadata.name}: the body is larger than 6 KiB`);
  return { kind: "web", metadata, header, body, source, path: filePath };
}

let cachedWeb: BundledWebSkill[] | undefined;

/** The web skills shipped inside Casper (today: web-frontend). */
export function webSkills(): BundledWebSkill[] {
  cachedWeb ??= [parseWebSkill(frontendSource, "skills/web/frontend/SKILL.md")];
  return cachedWeb;
}

/** Words that make a request UI work. Matched as whole words or phrases after normaliseWords. */
const UI_WORDS = [
  "ui", "user interface", "frontend", "front end", "web page", "webpage", "landing page", "homepage", "home page",
  "website", "web site", "web app", "webapp", "page", "pages", "layout", "css", "stylesheet", "style", "styles", "styling",
  "html", "button", "buttons", "form", "forms", "navbar", "nav bar", "menu", "modal", "dialog", "sidebar", "header",
  "footer", "component", "components", "screen", "theme", "dark mode", "responsive", "look", "looks", "design",
] as const;

/** Requests that ask about the UI rather than change it. */
const QUESTION_INTENTS = new Set(["inspect", "document", "visualize"]);

/** A styling system the project already uses: then the repo's look wins. */
const STYLING_FRAMEWORKS = ["tailwind", "styled-components", "emotion"];

/** The frontend skill's pick: UI work (not a question about it), in a project with no styles, components, design
 * folder or styling package yet. 6 when picked, else 0. A local word match, no model call. */
export function scoreWebSkill(
  request: string,
  project: Pick<ProjectModel, "architecture" | "frameworks">,
  classification: Pick<TaskClassification, "intent">,
): number {
  if (QUESTION_INTENTS.has(classification.intent)) return 0;
  const { ui, styles, design } = project.architecture;
  if (ui || styles || design || project.frameworks.some((framework) => STYLING_FRAMEWORKS.includes(framework))) return 0;
  const text = normaliseWords(request).join(" ");
  return UI_WORDS.some((word) => contains(text, word)) ? 6 : 0;
}

/** Every bundled skill: the network pack and the web skills. */
export function allBundledSkills(): AnyBundledSkill[] {
  return [...bundledSkills(), ...webSkills()];
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
