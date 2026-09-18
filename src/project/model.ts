import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProjectInfo } from "./inspect";

export type ProjectCommand = "build" | "test" | "lint" | "typecheck";

export interface ProjectModelOverrides {
  languages?: string[];
  frameworks?: string[];
  packageManager?: string;
  commands?: Record<string, string>;
  architecture?: Record<string, string>;
  conventions?: string[];
}

export interface ProjectModel {
  schemaVersion: 1;
  project: {
    name: string;
    root: string;
    git: boolean;
  };
  languages: string[];
  frameworks: string[];
  packageManager: string | null;
  commands: Partial<Record<ProjectCommand, string>>;
  architecture: Record<string, string>;
  conventions: string[];
  detectedAt: string;
}

export interface LoadProjectModelOptions {
  homeDir?: string;
  overrides?: ProjectModelOverrides;
}

interface CacheEntry {
  schemaVersion: 1;
  fingerprint: string;
  model: ProjectModel;
}

const SIGNAL_NAMES = new Set([
  "package.json",
  "bun.lock",
  "bun.lockb",
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "tsconfig.json",
  "jsconfig.json",
  "vite.config.ts",
  "vite.config.js",
  "next.config.ts",
  "next.config.js",
  "next.config.mjs",
  "svelte.config.js",
  "nuxt.config.ts",
  "pyproject.toml",
  "uv.lock",
  "requirements.txt",
  "poetry.lock",
  "Cargo.toml",
  "Cargo.lock",
  "go.mod",
  "go.sum",
  "Gemfile",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Package.swift",
  "Dockerfile",
]);

const FRAMEWORK_PACKAGES: Record<string, string> = {
  react: "react",
  next: "next",
  vue: "vue",
  nuxt: "nuxt",
  svelte: "svelte",
  "@sveltejs/kit": "sveltekit",
  "@angular/core": "angular",
  express: "express",
  fastify: "fastify",
  hono: "hono",
  "@nestjs/core": "nestjs",
  electron: "electron",
  "@tauri-apps/api": "tauri",
  vite: "vite",
};

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

async function rootSignals(root: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }

  return names.filter((name) => SIGNAL_NAMES.has(name)).sort();
}

async function fingerprint(
  root: string,
  signals: string[],
  overrides: ProjectModelOverrides,
): Promise<string> {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(overrides));

  for (const name of signals) {
    try {
      const details = await stat(path.join(root, name));
      hash.update(`${name}:${details.size}:${details.mtimeMs}\n`);
    } catch {
      hash.update(`${name}:missing\n`);
    }
  }

  return hash.digest("hex");
}

function cachePath(root: string, homeDir: string): string {
  const id = createHash("sha256").update(root).digest("hex").slice(0, 16);
  const safeName = path.basename(root).replace(/[^a-zA-Z0-9._-]/g, "-") || "project";
  return path.join(homeDir, ".casper", "projects", `${safeName}-${id}`, "project.json");
}

async function readCache(filePath: string, expectedFingerprint: string): Promise<ProjectModel | null> {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8")) as Partial<CacheEntry>;
    if (
      value.schemaVersion === 1 &&
      value.fingerprint === expectedFingerprint &&
      value.model?.schemaVersion === 1
    ) {
      return value.model;
    }
  } catch {
    // A missing or invalid cache is simply rebuilt from deterministic inputs.
  }
  return null;
}

async function writeCache(filePath: string, entry: CacheEntry): Promise<void> {
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
    await rename(temporaryPath, filePath);
  } catch {
    // Cache persistence must never prevent Casper from starting.
  }
}

async function readText(root: string, name: string): Promise<string | null> {
  try {
    return await readFile(path.join(root, name), "utf8");
  } catch {
    return null;
  }
}

function packageManagerFromField(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  return value.trim().split("@")[0] || null;
}

function detectPackageManager(names: Set<string>, packageJson: Record<string, unknown> | null): string | null {
  const declared = packageManagerFromField(packageJson?.packageManager);
  if (declared) {
    return declared;
  }
  if (names.has("bun.lock") || names.has("bun.lockb")) return "bun";
  if (names.has("pnpm-lock.yaml")) return "pnpm";
  if (names.has("yarn.lock")) return "yarn";
  if (names.has("package-lock.json")) return "npm";
  if (names.has("package.json")) return "npm";
  if (names.has("uv.lock")) return "uv";
  if (names.has("poetry.lock")) return "poetry";
  return null;
}

function packageScripts(packageJson: Record<string, unknown> | null): Record<string, string> {
  const scripts = packageJson?.scripts;
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(scripts).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function packageDependencies(packageJson: Record<string, unknown> | null): Set<string> {
  const result = new Set<string>();
  for (const section of ["dependencies", "devDependencies", "peerDependencies"]) {
    const dependencies = packageJson?.[section];
    if (typeof dependencies === "object" && dependencies !== null && !Array.isArray(dependencies)) {
      for (const name of Object.keys(dependencies)) {
        result.add(name);
      }
    }
  }
  return result;
}

function scriptCommand(packageManager: string, script: string): string {
  return `${packageManager} run ${script}`;
}

function nodeCommands(
  packageManager: string | null,
  scripts: Record<string, string>,
): Partial<Record<ProjectCommand, string>> {
  if (!packageManager) {
    return {};
  }

  const result: Partial<Record<ProjectCommand, string>> = {};
  const candidates: Record<ProjectCommand, string[]> = {
    test: ["test"],
    lint: ["lint"],
    typecheck: ["typecheck", "check-types", "tsc"],
    build: ["build"],
  };

  for (const [kind, names] of Object.entries(candidates) as [ProjectCommand, string[]][]) {
    const selected = names.find((name) => scripts[name]);
    if (selected) {
      result[kind] = scriptCommand(packageManager, selected);
    }
  }
  return result;
}

function detectPythonCommands(
  pyproject: string,
  packageManager: string | null,
): Partial<Record<ProjectCommand, string>> {
  const prefix = packageManager === "uv" ? "uv run " : packageManager === "poetry" ? "poetry run " : "";
  const commands: Partial<Record<ProjectCommand, string>> = {};
  if (/\bpytest\b/i.test(pyproject)) commands.test = `${prefix}pytest`;
  if (/\bruff\b/i.test(pyproject)) commands.lint = `${prefix}ruff check .`;
  if (/\bmypy\b/i.test(pyproject)) commands.typecheck = `${prefix}mypy .`;
  if (/\[build-system\]/.test(pyproject)) {
    commands.build = packageManager === "uv" ? "uv build" : "python -m build";
  }
  return commands;
}

async function detectModel(
  project: ProjectInfo,
  signals: string[],
  overrides: ProjectModelOverrides,
): Promise<ProjectModel> {
  const names = new Set(signals);
  const packageSource = await readText(project.root, "package.json");
  let packageJson: Record<string, unknown> | null = null;
  if (packageSource) {
    try {
      const parsed: unknown = JSON.parse(packageSource);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        packageJson = parsed as Record<string, unknown>;
      }
    } catch {
      // Other signals still provide a useful project model when package.json is invalid.
    }
  }

  const packageManager = overrides.packageManager ?? detectPackageManager(names, packageJson);
  const dependencies = packageDependencies(packageJson);
  const languages = new Set<string>();
  const frameworks = new Set<string>();

  if (names.has("tsconfig.json") || dependencies.has("typescript")) languages.add("typescript");
  else if (names.has("package.json")) languages.add("javascript");
  if (names.has("pyproject.toml") || names.has("requirements.txt")) languages.add("python");
  if (names.has("Cargo.toml")) languages.add("rust");
  if (names.has("go.mod")) languages.add("go");
  if (names.has("Gemfile")) languages.add("ruby");
  if (names.has("pom.xml") || names.has("build.gradle") || names.has("build.gradle.kts")) languages.add("java");
  if (names.has("Package.swift")) languages.add("swift");

  for (const [dependency, framework] of Object.entries(FRAMEWORK_PACKAGES)) {
    if (dependencies.has(dependency)) frameworks.add(framework);
  }
  if (names.has("next.config.ts") || names.has("next.config.js") || names.has("next.config.mjs")) frameworks.add("next");
  if (names.has("vite.config.ts") || names.has("vite.config.js")) frameworks.add("vite");

  let commands = nodeCommands(packageManager, packageScripts(packageJson));
  const pyproject = (await readText(project.root, "pyproject.toml")) ?? "";
  if (pyproject) {
    commands = { ...commands, ...detectPythonCommands(pyproject, packageManager) };
    if (/\bfastapi\b/i.test(pyproject)) frameworks.add("fastapi");
    if (/\bdjango\b/i.test(pyproject)) frameworks.add("django");
    if (/\bflask\b/i.test(pyproject)) frameworks.add("flask");
  }
  if (names.has("Cargo.toml")) {
    commands = { test: "cargo test", lint: "cargo clippy", build: "cargo build", ...commands };
  }
  if (names.has("go.mod")) {
    commands = { test: "go test ./...", build: "go build ./...", ...commands };
  }

  return {
    schemaVersion: 1,
    project: { name: project.name, root: project.root, git: project.isGit },
    languages: overrides.languages ?? sortedUnique(languages),
    frameworks: overrides.frameworks ?? sortedUnique(frameworks),
    packageManager,
    commands: { ...commands, ...(overrides.commands ?? {}) },
    architecture: overrides.architecture ?? {},
    conventions: overrides.conventions ?? [],
    detectedAt: new Date().toISOString(),
  };
}

export async function loadProjectModel(
  project: ProjectInfo,
  options: LoadProjectModelOptions = {},
): Promise<ProjectModel> {
  const homeDir = options.homeDir ?? os.homedir();
  const overrides = options.overrides ?? {};
  const signals = await rootSignals(project.root);
  const currentFingerprint = await fingerprint(project.root, signals, overrides);
  const filePath = cachePath(project.root, homeDir);
  const cached = await readCache(filePath, currentFingerprint);
  if (cached) {
    return cached;
  }

  const model = await detectModel(project, signals, overrides);
  await writeCache(filePath, { schemaVersion: 1, fingerprint: currentFingerprint, model });
  return model;
}
