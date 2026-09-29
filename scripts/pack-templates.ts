#!/usr/bin/env bun
/**
 * Packs templates/<id>/ into src/new/templates.generated.ts so the compiled binary carries them.
 *
 *   bun run scripts/pack-templates.ts           check the version lock, then write the generated file
 *   bun run scripts/pack-templates.ts --lock    also record new versions in templates/VERSIONS.json
 *   bun run scripts/pack-templates.ts --check   write nothing; exit 1 when the generated file or lock is stale
 *
 * Every template has an integer version in template.json. templates/VERSIONS.json locks each version
 * to a sha256 of the template's files, so a file can't change without a version bump.
 */
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PackedTemplate, TemplateManifest } from "../src/new/templates";

export const REPO_ROOT = path.resolve(import.meta.dir, "..");
export const TEMPLATES_DIR = path.join(REPO_ROOT, "templates");
export const GENERATED_FILE = path.join(REPO_ROOT, "src/new/templates.generated.ts");
export const VERSIONS_FILE = path.join(TEMPLATES_DIR, "VERSIONS.json");

export type VersionLock = Record<string, { version: number; sha256: string }>;

export interface ReadTemplate extends PackedTemplate {
  /** template.json exactly as written, part of the hash. */
  manifestText: string;
}

const MAX_FILE = 256 * 1024;
const FORBIDDEN_DIRS = new Set(["__pycache__", "node_modules", ".venv", "dist", ".git"]);

function fail(message: string): never {
  throw new Error(message);
}

function checkManifest(id: string, value: unknown): TemplateManifest {
  const m = value as Partial<TemplateManifest>;
  const where = `templates/${id}/template.json`;
  if (!m || typeof m !== "object") fail(`${where}: not an object`);
  if (m.id !== id) fail(`${where}: id must be "${id}"`);
  if (!Number.isInteger(m.version) || m.version! < 1) fail(`${where}: version must be a positive integer`);
  for (const key of ["kind", "title", "description", "defaultName"] as const) {
    if (typeof m[key] !== "string" || !m[key]) fail(`${where}: ${key} must be text`);
  }
  if (m.tool !== "uv" && m.tool !== "bun") fail(`${where}: tool must be uv or bun`);
  for (const key of ["init", "add", "addDev", "replace"] as const) {
    if (!Array.isArray(m[key]) || !m[key]!.every((item) => typeof item === "string" && item.length)) fail(`${where}: ${key} must be a list of text`);
  }
  if (m.init![0] !== m.tool) fail(`${where}: init must start with ${m.tool}`);
  if (typeof m.ready !== "boolean") fail(`${where}: ready must be true or false`);
  return m as TemplateManifest;
}

async function walk(root: string, relative: string, files: Record<string, string>): Promise<void> {
  const dir = relative ? path.join(root, relative) : root;
  for (const name of (await readdir(dir)).sort()) {
    const rel = relative ? `${relative}/${name}` : name;
    if (name === ".." || name === "." || path.isAbsolute(name) || name.includes("\\")) fail(`templates: bad path ${rel}`);
    if (name.startsWith(".")) fail(`templates: ${rel} is a dotfile; name it dot.${name.slice(1)} (it becomes ${name} in the project)`);
    const info = await lstat(path.join(dir, name));
    if (info.isSymbolicLink()) fail(`templates: ${rel} is a symlink; templates hold real files only`);
    if (info.isDirectory()) {
      if (FORBIDDEN_DIRS.has(name)) fail(`templates: ${rel} is build output; remove it`);
      await walk(root, rel, files);
    } else if (info.isFile()) {
      if (info.size > MAX_FILE) fail(`templates: ${rel} is over ${MAX_FILE} bytes`);
      const bytes = await readFile(path.join(dir, name));
      const text = bytes.toString("utf8");
      if (text.includes("\0") || !Buffer.from(text, "utf8").equals(bytes)) fail(`templates: ${rel} is not UTF-8 text`);
      files[rel] = text;
    } else fail(`templates: ${rel} is not a regular file`);
  }
}

/** Reads and checks one template folder. */
export async function readTemplate(templatesDir: string, id: string): Promise<ReadTemplate> {
  const root = path.join(templatesDir, id);
  const files: Record<string, string> = {};
  await walk(root, "", files);
  const manifestText = files["template.json"] ?? fail(`templates/${id}: no template.json`);
  delete files["template.json"];
  let parsed: unknown;
  try { parsed = JSON.parse(manifestText); } catch (error) { fail(`templates/${id}/template.json: ${(error as Error).message}`); }
  const manifest = checkManifest(id, parsed);
  for (const file of manifest.replace) if (!(file in files)) fail(`templates/${id}: replace lists ${file}, which isn't a template file`);
  return { manifest, files, manifestText };
}

/** Every template folder under templates/, sorted by id. */
export async function readTemplates(templatesDir = TEMPLATES_DIR): Promise<ReadTemplate[]> {
  const ids: string[] = [];
  for (const name of (await readdir(templatesDir)).sort()) {
    const info = await lstat(path.join(templatesDir, name));
    if (info.isSymbolicLink()) fail(`templates/${name} is a symlink`);
    if (info.isDirectory()) ids.push(name);
  }
  return Promise.all(ids.map((id) => readTemplate(templatesDir, id)));
}

/** sha256 over template.json and every file, in path order. */
export function templateHash(template: ReadTemplate): string {
  const hash = createHash("sha256");
  const entries: Array<[string, string]> = [["template.json", template.manifestText], ...Object.entries(template.files)];
  for (const [file, text] of entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    hash.update(file).update("\0").update(text).update("\0");
  }
  return hash.digest("hex");
}

/** The generated module, deterministic for the same input. */
export function renderGenerated(templates: readonly ReadTemplate[]): string {
  const lines = [
    "// Generated by scripts/pack-templates.ts from templates/. Do not edit by hand:",
    "// change the files under templates/, bump the version in template.json, then run",
    "// bun run scripts/pack-templates.ts --lock",
    'import type { PackedTemplate } from "./templates";',
    "",
    "export const TEMPLATES: Record<string, PackedTemplate> = {",
  ];
  for (const template of [...templates].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id))) {
    lines.push(`  ${JSON.stringify(template.manifest.id)}: {`);
    lines.push(`    manifest: ${JSON.stringify(template.manifest)},`);
    lines.push("    files: {");
    for (const file of Object.keys(template.files).sort()) {
      lines.push(`      ${JSON.stringify(file)}: ${JSON.stringify(template.files[file])},`);
    }
    lines.push("    },");
    lines.push("  },");
  }
  lines.push("};", "");
  return lines.join("\n");
}

/** Problems between the templates and the lock, plus the lock with any new versions recorded. */
export function checkLock(templates: readonly ReadTemplate[], lock: VersionLock): { problems: string[]; next: VersionLock } {
  const problems: string[] = [];
  const next: VersionLock = {};
  for (const template of templates) {
    const { id, version } = template.manifest;
    const sha256 = templateHash(template);
    const locked = lock[id];
    next[id] = { version, sha256 };
    if (!locked) { problems.push(`templates/${id} v${version} isn't in templates/VERSIONS.json (run with --lock)`); continue; }
    if (locked.version === version && locked.sha256 === sha256) continue;
    if (version <= locked.version) {
      problems.push(`templates/${id} changed but its version is still ${version}: bump "version" in template.json, then run with --lock`);
      next[id] = locked;
    } else problems.push(`templates/${id} is now v${version} (locked v${locked.version}); run with --lock`);
  }
  for (const id of Object.keys(lock)) if (!templates.some((t) => t.manifest.id === id)) problems.push(`templates/VERSIONS.json lists ${id}, which has no folder`);
  return { problems, next };
}

export async function readLock(file = VERSIONS_FILE): Promise<VersionLock> {
  try { return JSON.parse(await readFile(file, "utf8")) as VersionLock; } catch { return {}; }
}

export function renderLock(lock: VersionLock): string {
  const sorted = Object.fromEntries(Object.keys(lock).sort().map((id) => [id, lock[id]!]));
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

async function main(args: string[]): Promise<number> {
  const check = args.includes("--check");
  const writeLock = args.includes("--lock");
  const templates = await readTemplates();
  const lock = await readLock();
  const { problems, next } = checkLock(templates, lock);
  // --lock records new versions, never a changed file under an old version.
  const blocking = writeLock ? problems.filter((problem) => problem.includes("bump")) : problems;
  if (writeLock && !blocking.length && !check) {
    const pruned = Object.fromEntries(Object.entries(next).filter(([id]) => templates.some((t) => t.manifest.id === id)));
    await writeFile(VERSIONS_FILE, renderLock(pruned));
  }
  for (const problem of blocking) console.error(problem);
  if (blocking.length) return 1;
  const generated = renderGenerated(templates);
  if (check) {
    const current = await readFile(GENERATED_FILE, "utf8").catch(() => "");
    if (current !== generated) { console.error("src/new/templates.generated.ts is stale: run bun run scripts/pack-templates.ts"); return 1; }
    return 0;
  }
  await writeFile(GENERATED_FILE, generated);
  console.log(`Packed ${templates.length} templates into src/new/templates.generated.ts`);
  return 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
