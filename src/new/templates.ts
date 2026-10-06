import { TEMPLATES } from "./templates.generated";

/**
 * `casper new` templates. Each lives as real files under templates/<id>/ with a template.json
 * manifest; scripts/pack-templates.ts packs them into templates.generated.ts so the compiled
 * binary carries them. Nothing here runs a tool or reaches the network.
 */

export type TemplateTool = "uv" | "bun";

export interface TemplateManifest {
  id: string;
  /** Integer version, locked with a file hash in templates/VERSIONS.json and written into the first commit. */
  version: number;
  /** The short kind used in questions: "Mist Python project". */
  kind: string;
  /** The menu label: "Python tool (command line)". */
  title: string;
  /** One plain line for `casper new --list`. */
  description: string;
  /** The folder name used when the user just presses Enter. */
  defaultName: string;
  tool: TemplateTool;
  /** The init tool's argv, run as-is with shell off; {{name}} is filled in. */
  init: string[];
  /** Packages added with `uv add` / `bun add`. */
  add: string[];
  /** Dev packages added with `uv add --dev` / `bun add -d`. */
  addDev: string[];
  /** Template files that may replace a file the init tool wrote. Every other file is written only when new. */
  replace: string[];
  /** Fields merged into package.json after init (bun templates): {{name}} is filled in. */
  packageJson?: { name?: string; scripts?: Record<string, string> };
  /** Only ready templates are listed and picked. */
  ready: boolean;
}

export interface PackedTemplate {
  manifest: TemplateManifest;
  /** Template-relative path (forward slashes) to text, template.json excluded. */
  files: Record<string, string>;
}

export interface RenderValues {
  name: string;
  module: string;
  /** Upper-case env prefix: mist-aps -> MIST_APS. */
  env: string;
  year: string;
}

export interface RenderedFile {
  /** The template's own path (as listed in manifest.replace). */
  source: string;
  /** Target-relative path, forward slashes. */
  path: string;
  text: string;
  /** Appended to a file the init tool wrote (template files named `<file>.append`). */
  append: boolean;
}

/** The init tool's marker: the file that proves it wrote the project here. */
export const MARKER_FILE: Record<TemplateTool, string> = { uv: "pyproject.toml", bun: "package.json" };

/** Where each tool downloads packages from, on the default registry list. */
export const PACKAGE_HOST: Record<TemplateTool, string> = { uv: "pypi.org", bun: "registry.npmjs.org" };

export const NAME_RULE = "Names use lowercase letters, digits and dashes, like mist-aps.";

const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** A project name: lowercase letters, digits and single dashes, starting with a letter, 1-64 chars. */
export function validName(name: string): boolean {
  return name.length >= 1 && name.length <= 64 && NAME.test(name);
}

/** Every template, ready or not, in a fixed order. */
export function allTemplates(): TemplateManifest[] {
  return Object.values(TEMPLATES as Record<string, PackedTemplate>).map((template) => template.manifest)
    .sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id) || a.id.localeCompare(b.id));
}

/** Menu order: everyday network work first. */
const ORDER = ["python-cli", "network-mcp", "mist-python", "web-app", "vite-react", "noc-dashboard", "aoscx-ansible", "junos-ansible"];

/** The templates `casper new` offers. */
export function listTemplates(): TemplateManifest[] {
  return allTemplates().filter((template) => template.ready);
}

/** `casper new empty <name>` and "My own": no template, just a folder with git. */
export const EMPTY_TEMPLATE = "empty";

/** The help row for `casper new`: every kind it builds, by the word you type. */
export const NEW_HELP_LINE = `casper new [kind] [name]  Start a new project; asks what is missing, then opens Casper there. Kinds: ${[...listTemplates().map((template) => template.id), EMPTY_TEMPLATE].join(", ")} (casper new --list says what each is)`;
const EMPTY_DEFAULT_NAME = "my-project";

/** A template id Casper can build: a ready template, or empty. */
export function isBuildable(id: string): boolean {
  return id === EMPTY_TEMPLATE || Boolean(getTemplate(id)?.manifest.ready);
}

/** The folder name offered when the user just presses Enter. */
export function defaultNameFor(id: string): string {
  return getTemplate(id)?.manifest.defaultName ?? EMPTY_DEFAULT_NAME;
}

export function getTemplate(id: string): PackedTemplate | undefined {
  return Object.hasOwn(TEMPLATES, id) ? (TEMPLATES as Record<string, PackedTemplate>)[id] : undefined;
}

/** A Python module name for a project slug: mist-aps -> mist_aps. */
export function moduleName(slug: string): string {
  return slug.replace(/-/g, "_");
}

export function renderValues(name: string, now = new Date()): RenderValues {
  const module = moduleName(name);
  return { name, module, env: module.toUpperCase(), year: String(now.getFullYear()) };
}

/** Fills {{name}}, {{module}}, {{env}} and {{year}}. Other braces (Jinja `{{ var }}`) are left alone. */
export function fill(text: string, values: RenderValues): string {
  return text.replace(/\{\{(name|module|env|year)\}\}/g, (_, key: keyof RenderValues) => values[key]);
}

/**
 * The target path for a template path: a `__module__` segment becomes the module name, a leading
 * `dot.` becomes `.` (so template files never act as Casper's own dotfiles), and a trailing
 * `.append` marks text appended to a file the init tool wrote.
 */
export function targetPath(templatePath: string, values: RenderValues): { path: string; append: boolean } {
  const append = templatePath.endsWith(".append");
  const parts = (append ? templatePath.slice(0, -".append".length) : templatePath).split("/")
    .map((part) => part === "__module__" ? values.module : part.startsWith("dot.") ? `.${part.slice(4)}` : part);
  return { path: parts.join("/"), append };
}

export function renderFiles(template: PackedTemplate, values: RenderValues): RenderedFile[] {
  return Object.entries(template.files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([file, text]) => {
    const target = targetPath(file, values);
    return { source: file, path: target.path, append: target.append, text: fill(text, values) };
  });
}

/** The init argv with {{name}} filled in. */
export function initArgv(manifest: TemplateManifest, values: RenderValues): string[] {
  return manifest.init.map((arg) => fill(arg, values));
}

const STOPWORDS = new Set([
  "a", "an", "the", "my", "our", "your", "me", "us", "some", "new", "simple", "small", "little", "quick",
  "that", "which", "who", "to", "for", "of", "in", "on", "at", "by", "with", "from", "and", "or", "into", "across", "per", "each", "every", "all",
  "it", "this", "these", "those", "is", "are", "can", "will", "should", "would",
  "list", "lists", "show", "shows", "get", "gets", "pull", "pulls", "fetch", "fetches", "find", "finds", "check", "checks",
  "read", "reads", "print", "prints", "display", "displays", "return", "returns", "track", "tracks", "watch", "watches",
  "monitor", "monitors", "report", "reports", "collect", "collects", "export", "exports", "count", "counts", "let", "lets",
  "help", "helps", "give", "gives", "make", "makes", "do", "does",
  "what", "like", "similar", "kind", "sort", "something", "thing", "basically", "just",
  // Filler around a name: "new project folder called mist sites" is mist-sites.
  "folder", "folders", "directory", "dir", "called", "named", "name", "project", "projects",
]);

const BOUNDARY = new Set(["per", "for", "in", "on", "from", "by", "with", "to", "of", "at", "across", "into", "and", "or", "using", "via"]);

/**
 * A folder name from free text: up to 3 content words, stop words dropped, [a-z0-9-], 1-64 chars.
 * Collecting stops at a joining word once one word is kept ("Mist APs per site" -> mist-aps).
 * Empty when nothing usable is left.
 */
export function projectSlug(text: string): string {
  const words = text.toLowerCase().replace(/['’]/g, "").split(/[^a-z0-9]+/).filter(Boolean);
  const kept: string[] = [];
  for (const word of words) {
    if (kept.length && BOUNDARY.has(word)) break;
    if (STOPWORDS.has(word) || /^\d+$/.test(word) && !kept.length) continue;
    kept.push(word);
    if (kept.length === 3) break;
  }
  let slug = kept.join("-").slice(0, 64).replace(/-+$/, "");
  if (slug && !/^[a-z]/.test(slug)) slug = `p-${slug}`.slice(0, 64);
  return validName(slug) ? slug : "";
}
