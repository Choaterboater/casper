import { isConfigFile as isDeviceConfig } from "../network/risky-receipt";
import { appDataFile } from "../services/app-data";

/**
 * Config files: the settings a project, its tools and its machines run with, as against its code. A receipt names the
 * ones a task changed on a row of their own, so a settings change is never lost in a file count.
 *
 * Project and tool settings (package.json and other dependency lists, tsconfig, .env files, YAML, TOML, INI,
 * .properties, *.config.* and rc files, Dockerfiles and compose files, CI workflows, .casper/project.yaml), Ansible
 * inventories and variables, and device configs: the files the risky-lines check reads (Junos .set, .conf, .cfg,
 * configs/ and oxidized/ backups). Lockfiles are config too, but a dependency update rewrites them wholesale, so a
 * receipt names them as one entry.
 */

const LOCKFILES = new Set(["bun.lock", "bun.lockb", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "deno.lock",
  "uv.lock", "poetry.lock", "pipfile.lock", "pdm.lock", "cargo.lock", "go.sum", "gemfile.lock", "composer.lock", "flake.lock",
  "packages.lock.json", "gradle.lockfile", ".terraform.lock.hcl", "podfile.lock", "pubspec.lock", "mix.lock"]);

/** Dependency lists known by name, and Ansible inventories with no extension. */
const NAMES = new Set(["package.json", "deno.json", "deno.jsonc", "jsconfig.json", "go.mod", "gemfile", "pipfile", "inventory", "hosts"]);

const SETTINGS = [
  /\.(?:ya?ml|toml|ini|properties|env|conf|cfg)$/i,
  /^tsconfig[\w.-]*\.json$/i,
  /^\.env(?:\..+)?$/i,
  /^(?:docker|container)file(?:\.[\w.-]+)?$|\.(?:docker|container)file$/i,
  /^requirements[\w.-]*\.txt$/i,
  /\.config\.(?:[cm]?[jt]s|json)$/i,
  /^\.[\w-]+rc(?:\.(?:json|ya?ml|[cm]?js))?$/i,
];

const parts = (file: string) => file.split(/[\\/]/);

/** A dependency lockfile (bun.lock, package-lock.json, Cargo.lock …), by its name. */
export function isLockfile(file: string): boolean {
  return LOCKFILES.has((parts(file).at(-1) ?? "").toLowerCase());
}

/** Whether a changed file (relative to the project, / or \ separated) is config. */
export function isConfigFile(file: string): boolean {
  const all = parts(file);
  const name = all.at(-1) ?? "";
  const folders = all.slice(0, -1).map((folder) => folder.toLowerCase());
  if (isLockfile(file) || NAMES.has(name.toLowerCase()) || SETTINGS.some((pattern) => pattern.test(name))) return true;
  if (folders.some((folder, index) => folder === ".github" && folders[index + 1] === "workflows")) return true;
  if (folders.some((folder) => folder === "group_vars" || folder === "host_vars")) return true;
  // Inventory folders hold host lists with no extension; code in a folder of that name stays code.
  if (!name.includes(".") && folders.some((folder) => folder === "inventory" || folder === "inventories")) return true;
  return isDeviceConfig(file);
}

export interface ConfigChanges {
  /** Config files other than lockfiles, in the order given. */
  files: string[];
  lockfiles: string[];
}

/** The config files among these paths, lockfiles apart. */
export function configChanges(files: readonly string[]): ConfigChanges {
  const found: ConfigChanges = { files: [], lockfiles: [] };
  for (const file of files) {
    if (isLockfile(file)) found.lockfiles.push(file);
    else if (isConfigFile(file)) found.files.push(file);
  }
  return found;
}

/** How a receipt lists them: each config file, then the lockfiles as one entry ("bun.lock", "3 lockfiles"). */
export function configEntries({ files, lockfiles }: ConfigChanges): string[] {
  return [...files, ...lockfiles.length > 1 ? [`${lockfiles.length} lockfiles`] : lockfiles];
}

/** Dependency lists and build settings: a repair may change them for good reason, so they are not flagged as app data. */
const BUILD_SETTINGS = /^(?:package\.json|deno\.jsonc?|jsconfig\.json|tsconfig[\w.-]*\.json|pyproject\.toml|cargo\.toml|requirements[\w.-]*\.txt)$/i;

/** Settings or data an app reads as it runs (config/*.yaml, .env, data.json, a SQLite file), not its code, lockfiles or
 * dependency lists. A check or repair that changed one may have left test data in what ships. */
export function isAppSettingsOrData(file: string): boolean {
  const name = parts(file).at(-1) ?? "";
  if (isLockfile(file) || BUILD_SETTINGS.test(name)) return false;
  return appDataFile(file) || SETTINGS[0]!.test(name) || SETTINGS[2]!.test(name);
}
