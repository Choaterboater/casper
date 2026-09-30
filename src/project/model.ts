import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProjectInfo } from "./inspect";
import type { NamedCheckSpec } from "../verify/named";
import type { MigrationPlan } from "../verify/migrations";
import type { VerificationScope } from "../verify/scope";
import { detectRepositoryStructure, STRUCTURE_PROBES } from "./structure";

export type ProjectCommand = "build" | "test" | "lint" | "typecheck";

export interface ProjectModelOverrides {
  languages?: string[];
  frameworks?: string[];
  packageManager?: string;
  commands?: Partial<Record<ProjectCommand, string>>;
  verificationScopes?: Partial<Record<ProjectCommand, VerificationScope>>;
  /** verify.checks: the project's named checks. */
  namedChecks?: Record<string, NamedCheckSpec>;
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
  verificationScopes?: Partial<Record<ProjectCommand, VerificationScope>>;
  /** Checks the project named under verify.checks, next to the four built-in ones. */
  namedChecks?: Record<string, NamedCheckSpec>;
  /** SQL migrations found in the project (the migrations check); found when the project is opened, never cached. */
  migrations?: MigrationPlan;
  /** Ready-made checks Casper found for the project (Ansible playbooks) that the project has not saved under
   * verify.checks. They never run until the user adds one (/verify add <name>); found when opened, never cached. */
  foundChecks?: Record<string, NamedCheckSpec>;
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

export const PROJECT_SIGNAL_NAMES = new Set([
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
  tailwindcss: "tailwind",
  "styled-components": "styled-components",
  "@emotion/react": "emotion",
};

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

// 3: Python network SDKs (mistapi, pycentral, pyaoscx, pyclearpass, junos-eznc, ncclient) give frameworks.
// 4: a Python project with test_*.py files and no pytest runs them with unittest.
// 5: only test*.py files that use unittest count (pytest-style files would run no tests and still pass).
// 6: `python -m build` only when the build package is there; Swift packages get swift test and swift build;
//    uv and poetry run unittest as `uv run python -m unittest` (there is no `unittest` program).
/** Bump when detection changes what it derives from the same files, so cached models are rebuilt. */
const DETECTION_VERSION = 6;
/** requirements.txt, requirements-dev.txt, requirements_test.txt ...: Python projects without a pyproject. */
const REQUIREMENTS = /^requirements[\w.-]*\.txt$/i;
/** Python package names (as a whole word, not inside another name) and the framework they give. */
const PYTHON_NETWORK_SDKS: Array<[RegExp, string]> = [
  [/(?<![\w-])mistapi(?![\w-])/i, "mist"],
  [/(?<![\w-])pycentral(?![\w-])/i, "central"],
  [/(?<![\w-])pyaoscx(?![\w-])/i, "aoscx"],
  [/(?<![\w-])pyclearpass(?![\w-])/i, "clearpass"],
  [/(?<![\w-])(?:junos-eznc|ncclient)(?![\w-])/i, "junos"],
];
/** A project-local virtual environment decides which Python runs the tools. */
export const VIRTUALENVS = [".venv", "venv"];

async function rootSignals(root: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }

  return names.filter((name) => PROJECT_SIGNAL_NAMES.has(name) || REQUIREMENTS.test(name)).sort();
}

async function fingerprint(
  root: string,
  signals: string[],
  overrides: ProjectModelOverrides,
): Promise<string> {
  const hash = createHash("sha256");
  hash.update(`detection:${DETECTION_VERSION}\n`);
  hash.update(JSON.stringify(overrides));

  for (const name of signals) {
    try {
      const details = await stat(path.join(root, name));
      hash.update(`${name}:${details.size}:${details.mtimeMs}\n`);
    } catch {
      hash.update(`${name}:missing\n`);
    }
  }
  for (const relative of [...STRUCTURE_PROBES, ...VIRTUALENVS, ...UNITTEST_DIRS]) {
    try {
      const details = await lstat(path.join(root, relative));
      const kind = details.isSymbolicLink() ? "link" : details.isDirectory() ? "dir" : "file";
      hash.update(`${relative}:${kind}:${details.size}:${details.mtimeMs}\n`);
    } catch {
      hash.update(`${relative}:missing\n`);
    }
  }
  // Installing build into the environment changes site-packages, not the environment folder itself.
  for (const name of VIRTUALENVS) hash.update(`${name}:build:${await virtualenvHasBuild(root, name)}\n`);

  return hash.digest("hex");
}

export function projectStateDirectory(root: string, homeDir: string): string {
  const id = createHash("sha256").update(root).digest("hex").slice(0, 16);
  const safeName = path.basename(root).replace(/[^a-zA-Z0-9._-]/g, "-") || "project";
  return path.join(homeDir, ".casper", "projects", `${safeName}-${id}`);
}

function cachePath(root: string, homeDir: string): string {
  return path.join(projectStateDirectory(root, homeDir), "project.json");
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
  if (names.has("Package.swift")) return "swift";
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

/** Where Python tools run: the project's own runner (uv, poetry), else its virtual environment's
 * interpreter, else the system Python, always as `python -m tool` so a missing script shim never matters. */
export function pythonRunner(names: Set<string>, pyproject: string, virtualenv: string | null): { tool: (name: string) => string; python: string; build: string; buildNeedsPackage: boolean } {
  const poetry = names.has("poetry.lock") || /^\[tool\.poetry\]/m.test(pyproject);
  if (names.has("uv.lock")) return { tool: (name) => `uv run ${name}`, python: "uv run python", build: "uv build", buildNeedsPackage: false };
  if (poetry) return { tool: (name) => `poetry run ${name}`, python: "poetry run python", build: "poetry build", buildNeedsPackage: false };
  const python = virtualenv
    ? process.platform === "win32" ? `${virtualenv}\\Scripts\\python.exe` : `${virtualenv}/bin/python`
    : process.platform === "win32" ? "python" : "python3";
  // `python -m build` needs the `build` package; uv and poetry build on their own.
  return { tool: (name) => `${python} -m ${name}`, python, build: `${python} -m build`, buildNeedsPackage: true };
}

/** The pyproject text that lists packages: `dependencies` and `dev-dependencies` arrays, and whole
 * `*dependencies` and `[dependency-groups]` tables. Not tool settings like ruff's `exclude = ["build"]`. */
function pyprojectDependencies(pyproject: string): string {
  const parts: string[] = [];
  let table = "";
  const lines = pyproject.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
    if (header) { table = header[1]!.trim(); continue; }
    if (/(?:^|[.-])dependencies$|^dependency-groups$/.test(table)) { parts.push(line); continue; }
    if (!/^\s*(?:dev-)?dependencies\s*=\s*\[/.test(line)) continue;
    // The array, to its closing bracket (brackets inside quotes, like "pkg[extra]", don't count).
    const start = index;
    let depth = 0;
    let quote = "";
    for (; index < lines.length; index++) {
      const text = lines[index]!;
      parts.push(text);
      for (const char of index === start ? text.slice(text.indexOf("=")) : text) {
        if (quote) { if (char === quote) quote = ""; }
        else if (char === '"' || char === "'") quote = char;
        else if (char === "#") break;
        else if (char === "[") depth++;
        else if (char === "]") depth--;
      }
      if (depth <= 0) break;
    }
  }
  return parts.join("\n");
}

/** `build` listed as a package: in pyproject's dependency lists, or a `build` line in a requirements file. */
function listsBuildPackage(pyproject: string, requirements: string): boolean {
  const dependencies = pyprojectDependencies(pyproject);
  return /["']build\s*(?:[<>=!~[;@"']|$)/im.test(dependencies) || /^\s*build\s*=/m.test(dependencies)
    || /^\s*build\s*(?:[<>=!~[;@#]|$)/im.test(requirements);
}

/** The `build` package installed in the project's virtual environment. */
export async function virtualenvHasBuild(root: string, virtualenv: string): Promise<boolean> {
  const isDir = async (folder: string) => (await stat(folder).catch(() => undefined))?.isDirectory() ?? false;
  if (await isDir(path.join(root, virtualenv, "Lib", "site-packages", "build"))) return true; // Windows
  const lib = path.join(root, virtualenv, "lib");
  const pythons = (await readdir(lib).catch(() => [] as string[])).filter((name) => /^python\d/.test(name));
  for (const name of pythons) if (await isDir(path.join(lib, name, "site-packages", "build"))) return true;
  return false;
}

/** The body of one TOML table, up to the next table header. */
function tomlTable(source: string, name: string): string | null {
  const start = source.search(new RegExp(`^\\[${name.replace(/\./g, "\\.")}\\]\\s*$`, "m"));
  if (start < 0) return null;
  const rest = source.slice(start).split("\n").slice(1);
  const end = rest.findIndex((line) => /^\[/.test(line));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

/** Folders a plain unittest suite sits in; the project root counts too. */
const UNITTEST_DIRS = ["tests", "test"];
/** unittest's own discovery pattern (test*.py): foo_test.py files would not run, and the check would pass on none. */
const TEST_FILE = /^test.*\.py$/;

/** "python3 -m unittest discover -s tests" when a Python project has unittest test files (test*.py that use
 * unittest) but no pytest: the standard library runs them, nothing to install. pytest-style files are left out, since
 * unittest would run none of their tests and still say OK. Undefined when there are none. */
export async function unittestCommand(root: string, runner: ReturnType<typeof pythonRunner>): Promise<string | undefined> {
  const hasTests = async (dir: string) => {
    const files = (await readdir(dir).catch(() => [] as string[])).filter((name) => TEST_FILE.test(name)).slice(0, 50);
    for (const name of files) {
      const text = await readFile(path.join(dir, name), "utf8").then((source) => source.slice(0, 256 * 1024), () => "");
      if (/\bunittest\b|\bTestCase\b/.test(text)) return true;
    }
    return false;
  };
  for (const dir of UNITTEST_DIRS) {
    if (await hasTests(path.join(root, dir))) return `${runner.python} -m unittest discover -s ${dir}`;
  }
  return await hasTests(root) ? `${runner.python} -m unittest discover` : undefined;
}

export function detectPythonCommands(
  pyproject: string,
  requirements: string,
  runner: ReturnType<typeof pythonRunner>,
  /** The `build` package is installed in the project's virtual environment. */
  buildInstalled = false,
): Partial<Record<ProjectCommand, string>> {
  const sources = `${pyproject}\n${requirements}`;
  const commands: Partial<Record<ProjectCommand, string>> = {};
  if (/\bpytest\b/i.test(sources)) commands.test = runner.tool("pytest");
  if (/\bruff\b/i.test(sources)) commands.lint = runner.tool("ruff check .");
  // `mypy .` ignores the files list in [tool.mypy]; bare mypy checks exactly those.
  if (/\bmypy\b/i.test(sources)) commands.typecheck = runner.tool(/^\s*files\s*=/m.test(tomlTable(pyproject, "tool.mypy") ?? "") ? "mypy" : "mypy .");
  // Without the build tool, `python -m build` fails with "No module named build": no build check at all.
  const canBuild = !runner.buildNeedsPackage || buildInstalled || listsBuildPackage(pyproject, requirements);
  if (/\[build-system\]/.test(pyproject) && canBuild) commands.build = runner.build;
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
  const requirementFiles = signals.filter((name) => REQUIREMENTS.test(name));
  if (names.has("pyproject.toml") || requirementFiles.length) languages.add("python");
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
  const requirements = (await Promise.all(requirementFiles.map((name) => readText(project.root, name)))).join("\n");
  if (pyproject || requirements) {
    const virtualenv = (await Promise.all(VIRTUALENVS.map(async (name) => (await lstat(path.join(project.root, name)).catch(() => undefined))?.isDirectory() ? name : null)))
      .find(Boolean) ?? null;
    const runner = pythonRunner(names, pyproject, virtualenv);
    const buildInstalled = virtualenv ? await virtualenvHasBuild(project.root, virtualenv) : false;
    commands = { ...commands, ...detectPythonCommands(pyproject, requirements, runner, buildInstalled) };
    if (!commands.test) {
      const unittest = await unittestCommand(project.root, runner);
      if (unittest) commands.test = unittest;
    }
    if (/\bfastapi\b/i.test(pyproject)) frameworks.add("fastapi");
    if (/\bdjango\b/i.test(pyproject)) frameworks.add("django");
    if (/\bflask\b/i.test(pyproject)) frameworks.add("flask");
    // Network SDKs: a bundled network skill counts the project's SDK as one reason to load.
    const python = `${pyproject}\n${requirements}`;
    for (const [pattern, framework] of PYTHON_NETWORK_SDKS) if (pattern.test(python)) frameworks.add(framework);
  }
  if (names.has("Cargo.toml")) {
    commands = { test: "cargo test", lint: "cargo clippy", build: "cargo build", ...commands };
  }
  if (names.has("go.mod")) {
    commands = { test: "go test ./...", build: "go build ./...", ...commands };
  }
  // A Swift package. An Xcode project alone gets no guessed xcodebuild commands.
  if (names.has("Package.swift")) {
    // On macOS SwiftPM sandboxes its own manifest step, which can't start inside Casper's sandbox. The flag
    // is saved in the model, so it's there even with Casper's sandbox off; a project's own commands replace it.
    const flag = process.platform === "darwin" ? " --disable-sandbox" : "";
    commands = { test: `swift test${flag}`, build: `swift build${flag}`, ...commands };
  }
  const structure = await detectRepositoryStructure(project.root);

  return {
    schemaVersion: 1,
    project: { name: project.name, root: project.root, git: project.isGit },
    languages: overrides.languages ?? sortedUnique(languages),
    frameworks: overrides.frameworks ?? sortedUnique(frameworks),
    packageManager,
    commands: { ...commands, ...(overrides.commands ?? {}) },
    verificationScopes: overrides.verificationScopes,
    ...(overrides.namedChecks && Object.keys(overrides.namedChecks).length ? { namedChecks: overrides.namedChecks } : {}),
    architecture: overrides.architecture ?? structure.architecture,
    conventions: overrides.conventions ?? structure.conventions,
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
