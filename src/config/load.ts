import { readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { isValidProfileName } from "./profile";
import { readReferenceFile } from "../references/files";
import type { ProjectCommand, ProjectModelOverrides } from "../project/model";
import { CHECK_NAMES, type CheckName } from "../verify/evidence";
import { labNamedChecks, parseNamedChecks } from "../verify/named";
import { LAB_IN_PROJECT_ERROR, mergeLabSettings, parseLabSettings, type LabSettings } from "../network/spec";
import { SKILL_IMPORTS, type SkillImport } from "../skills/registry";
import { isVerificationScope, type VerificationScope } from "../verify/scope";
import { VERIFICATION_MODES, type VerificationMode, type VerificationSettings } from "../verify/mode";
import { resolveVisualizationSettings, type VisualizationSettings } from "../visualize/router";
import { parseServices, type ServiceSpec } from "../services/config";
import { parseSmoke, type SmokeCheck } from "../services/smoke";
import { parsePagesSetting, type PagesSetting } from "../services/pages";
import type { SandboxProjectSettings, SandboxUserSettings } from "../sandbox/policy";
import { PROMPT_CACHE_SETTINGS, type PromptCacheSetting } from "../runtime/cache";
import { DISPLAY_LEVELS, type DisplayLevel } from "../tui/display";
import { DEFAULT_SPEND_LIMITS, type SpendLimits } from "../task/spend";
import { isOutside } from "../platform/inside";


/** `showPages:` whether the AI is shown page screenshots after a UI change: ask once a session, always, or never. */
export const SHOW_PAGES_SETTINGS = ["ask", "on", "off"] as const;
export type ShowPagesSetting = typeof SHOW_PAGES_SETTINGS[number];
export type Autonomy = "low" | "medium" | "high";
export type AskQuestions = "beforeChanges" | "onlyWhenBlocked";
export type GitActionPolicy = "never" | "neverUnlessRequested";

export interface CasperPolicy {
  behavior: {
    autonomy: Autonomy;
    askQuestions: AskQuestions;
    inspectBeforeEditing: boolean;
  };
  code: {
    reuseExistingPatterns: boolean;
    preserveArchitecture: boolean;
    avoidOverengineering: boolean;
    avoidUnnecessaryDependencies: boolean;
    preferSmallChanges: boolean;
  };
  git: {
    commit: GitActionPolicy;
    push: GitActionPolicy;
    confirmDestructive: true;
  };
  workspace: {
    isolateWhen: {
      parallelAgents: boolean;
      riskyRefactor: boolean;
      experimentalBranch: boolean;
    };
  };
}

export interface LoadedConfiguration {
  profileName: string;
  policy: CasperPolicy;
  profileRules: string | null;
  projectRules: string | null;
  projectOverrides: ProjectModelOverrides;
  /** bundled: the network skills shipped with Casper (default on; user or profile only). */
  skills: { maxActive: number; imports: SkillImport[]; bundled?: boolean };
  verification: VerificationSettings;
  /** bigModelLastTry: the last repair runs on the user's big model (the reason role); user or profile only. */
  repair: { maxAttempts: number; bigModelLastTry?: boolean };
  /** `suggestions: false` turns every suggestion off (user or profile only). */
  suggestions?: boolean;
  /** `updates: false` turns off the line that says a newer Casper is out (user or profile only). */
  updates?: boolean;
  /** `sideQuestions: false`: a line that starts with `?` is an ordinary request, not a side question (user or profile only). */
  sideQuestions?: boolean;
  /** `cache: auto|long|short|off`: how long the provider keeps the prompt cache (user or profile only). Unset: auto. */
  cache?: PromptCacheSetting;
  /** `display: quiet|normal|detailed`: how much of the work shows on screen (user or profile only). Unset: normal. */
  display?: DisplayLevel;
  /** `showPages: ask|on|off`: whether a model that sees pictures is shown the page screenshots after a UI change
   * (user or profile only; it costs tokens). Unset: ask once a session. */
  showPages?: ShowPagesSetting;
  /** `delegate.build: false`: the AI starts no builders (helpers that edit in their own copy). Yours (user or
   * profile); a project file can turn them off for itself, never back on. Unset: on. */
  delegate?: { build: false };
  /** Per-task spend limits in dollars (a note, then a pause); unset turns one off. User or profile only. */
  spend: SpendLimits;
  visualize: VisualizationSettings;
  /** Declared managed services (project layer only), by name. */
  services: Record<string, ServiceSpec>;
  /** Configured smoke checks against those services (project layer only). */
  smoke: SmokeCheck[];
  /** Pages the page check always opens, or off (project layer only). Unset: the changed pages. */
  pages?: PagesSetting;
  /** The user's lab devices (lab.hosts), from ~/.casper/config.yaml or the profile only; never a project file. */
  lab?: LabSettings;
  /** The profile whose own lab list replaces yours (~/.casper/profiles/<name>/config.yaml), when it has one. */
  labProfile?: string;
  /** The shell sandbox: your settings (sandbox, shell.keepEnv) and the project's extra denies. */
  sandbox: { user: SandboxUserSettings; project: SandboxProjectSettings };
  /** Web lookups, from ~/.casper/config.yaml or the profile only; never a project file. */
  web: WebSettings;
  /** The untrusted-text reader (casper_read_untrusted): on/off is yours only; a project may add untrusted paths. */
  reader: ReaderSettings;
  /** Unknown keys, by file; shown at startup and otherwise ignored. */
  warnings: string[];
}

/** Web lookups (web_search, web_fetch): on unless you turn them off; your own setting only. */
export interface WebSettings { enabled: boolean; provider: "duckduckgo" | "brave" | "searxng"; searxngUrl?: string }

export const DEFAULT_WEB: WebSettings = { enabled: true, provider: "duckduckgo" };

/** casper_read_untrusted: on unless you turn it off (no cost until the AI calls it). `untrusted`: paths whose text
 * the AI is told to read through it; empty changes nothing. */
export interface ReaderSettings { enabled: boolean; untrusted: string[] }

export const DEFAULT_READER: ReaderSettings = { enabled: true, untrusted: [] };

export interface LoadConfigurationOptions {
  projectRoot: string;
  homeDir?: string;
  profileName?: string;
}

type Mapping = Record<string, unknown>;
type PolicyLayer = {
  behavior?: Partial<CasperPolicy["behavior"]>;
  code?: Partial<CasperPolicy["code"]>;
  git?: Partial<Omit<CasperPolicy["git"], "confirmDestructive">> & {
    confirmDestructive?: boolean;
  };
  workspace?: {
    isolateWhen?: Partial<CasperPolicy["workspace"]["isolateWhen"]>;
  };
};

export const SAFE_DEFAULT_POLICY: CasperPolicy = {
  behavior: {
    autonomy: "high",
    askQuestions: "onlyWhenBlocked",
    inspectBeforeEditing: true,
  },
  code: {
    reuseExistingPatterns: true,
    preserveArchitecture: true,
    avoidOverengineering: true,
    avoidUnnecessaryDependencies: true,
    preferSmallChanges: true,
  },
  git: {
    commit: "neverUnlessRequested",
    push: "neverUnlessRequested",
    confirmDestructive: true,
  },
  workspace: {
    isolateWhen: {
      parallelAgents: true,
      riskyRefactor: true,
      experimentalBranch: true,
    },
  },
};

function isMapping(value: unknown): value is Mapping {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Repository files are bounded: rules ride along with every prompt. */
const MAX_PROJECT_YAML_BYTES = 256 * 1024;
const MAX_PROJECT_RULES_BYTES = 64 * 1024;

/** A repository-controlled file. Its realpath must stay under the project root, so a committed
 * symlink cannot pull `~/.aws/credentials` into the prompt; the read is bounded and never
 * waits on a special file. User and profile files are the user's own and may link anywhere. */
async function readProjectFile(projectRoot: string, relative: string, maxBytes: number): Promise<string | null> {
  let real: string;
  try {
    real = await realpath(path.join(projectRoot, relative));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const inside = path.relative(await realpath(projectRoot), real);
  if (!inside || isOutside(inside)) {
    throw new Error(`${relative} resolves outside the project; refusing to read it`);
  }
  try {
    return (await readReferenceFile(real, maxBytes)).toString("utf8");
  } catch (error) {
    throw new Error(`Cannot read ${relative}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readYaml(filePath: string, projectRoot?: string): Promise<Mapping> {
  let source: string;

  if (projectRoot) {
    const text = await readProjectFile(projectRoot, ".casper/project.yaml", MAX_PROJECT_YAML_BYTES);
    if (text === null) return {};
    source = text;
  } else try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }

  try {
    const value: unknown = parse(source);
    if (value === null || value === undefined) {
      return {};
    }
    if (!isMapping(value)) {
      throw new Error("expected a YAML mapping");
    }
    return value;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid Casper configuration at ${filePath}: ${message}`);
  }
}

async function readOptionalText(filePath: string): Promise<string | null> {
  try {
    const value = (await readFile(filePath, "utf8")).trim();
    return value || null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Policy sections and their keys; anything else in a config file is reported, not applied. */
const POLICY_KEYS = {
  behavior: ["autonomy", "askQuestions", "inspectBeforeEditing"],
  code: ["reuseExistingPatterns", "preserveArchitecture", "avoidOverengineering", "avoidUnnecessaryDependencies", "preferSmallChanges"],
  git: ["commit", "push", "confirmDestructive"],
  workspace: ["isolateWhen"],
} as const;
const ISOLATE_KEYS = ["parallelAgents", "riskyRefactor", "experimentalBranch"];
const TOP_LEVEL_KEYS = new Set(["profile", "project", "languages", "frameworks", "packageManager", "commands", "architecture",
  "conventions", "verify", "verification", "repair", "skills", "visualize", "policy", "services", "smoke", "pages", "lab", "suggestions", "updates", "sideQuestions", "cache", "display", "showPages", "spend", "sandbox", "shell", "web", "reader", "delegate", ...Object.keys(POLICY_KEYS)]);

/** Typos used to fall back silently to the defaults; the loader names them instead. */
function unknownKeys(document: Mapping, label: string): string[] {
  const unknown: string[] = [];
  const check = (value: unknown, prefix: string, known: readonly string[]) => {
    if (isMapping(value)) for (const key of Object.keys(value)) if (!known.includes(key)) unknown.push(`${prefix}${key}`);
  };
  check(document, "", [...TOP_LEVEL_KEYS]);
  check(document.policy, "policy.", Object.keys(POLICY_KEYS));
  check(document.spend, "spend.", ["noteAt", "pauseAt"]);
  check(document.delegate, "delegate.", ["build"]);
  for (const [name, keys] of Object.entries(POLICY_KEYS)) {
    check(document[name], `${name}.`, keys);
    if (isMapping(document.policy)) check(document.policy[name], `policy.${name}.`, keys);
  }
  const workspaces = [document.workspace, isMapping(document.policy) ? document.policy.workspace : undefined];
  for (const workspace of workspaces) if (isMapping(workspace)) check(workspace.isolateWhen, "workspace.isolateWhen.", ISOLATE_KEYS);
  return unknown.map((key) => `${label}: unknown key ${key} (ignored)`);
}

function alternatives(values: readonly string[]): string {
  return values.length > 1 ? `${values.slice(0, -1).join(", ")} or ${values.at(-1)}` : values.join("");
}

function policyLayer(document: Mapping, label: string): PolicyLayer {
  // YAML `key:` with no value is null: treated as unset, like an absent key.
  const mapping = (value: unknown, name: string): Mapping => {
    if (value === undefined || value === null) return {};
    if (!isMapping(value)) throw new Error(`Invalid ${label}: ${name} must be a mapping`);
    return value;
  };
  const nested = mapping(document.policy, "policy");
  const section = (name: string): Mapping => ({
    ...mapping(document[name], name),
    ...mapping(nested[name], `policy.${name}`),
  });
  // Reads one section; an invalid value fails with its dotted name and the allowed values.
  const read = (prefix: string, values: Mapping) => ({
    choice: <T extends string>(key: string, allowed: readonly T[]): T | undefined => {
      const value = values[key];
      if (value === undefined || value === null) return undefined;
      if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
      throw new Error(`Invalid ${label}: ${prefix}.${key} must be ${alternatives(allowed)}`);
    },
    flag: (key: string): boolean | undefined => {
      const value = values[key];
      if (value === undefined || value === null) return undefined;
      if (typeof value === "boolean") return value;
      throw new Error(`Invalid ${label}: ${prefix}.${key} must be true or false`);
    },
  });
  const behavior = read("behavior", section("behavior"));
  const code = read("code", section("code"));
  const git = read("git", section("git"));
  const workspace = section("workspace");
  const isolateWhen = read("workspace.isolateWhen", mapping(workspace.isolateWhen, "workspace.isolateWhen"));

  return {
    behavior: {
      autonomy: behavior.choice("autonomy", ["low", "medium", "high"] as const),
      askQuestions: behavior.choice("askQuestions", ["beforeChanges", "onlyWhenBlocked"] as const),
      inspectBeforeEditing: behavior.flag("inspectBeforeEditing"),
    },
    code: {
      reuseExistingPatterns: code.flag("reuseExistingPatterns"),
      preserveArchitecture: code.flag("preserveArchitecture"),
      avoidOverengineering: code.flag("avoidOverengineering"),
      avoidUnnecessaryDependencies: code.flag("avoidUnnecessaryDependencies"),
      preferSmallChanges: code.flag("preferSmallChanges"),
    },
    git: {
      commit: git.choice("commit", ["never", "neverUnlessRequested"] as const),
      push: git.choice("push", ["never", "neverUnlessRequested"] as const),
      confirmDestructive: git.flag("confirmDestructive"),
    },
    workspace: {
      isolateWhen: {
        parallelAgents: isolateWhen.flag("parallelAgents"),
        riskyRefactor: isolateWhen.flag("riskyRefactor"),
        experimentalBranch: isolateWhen.flag("experimentalBranch"),
      },
    },
  };
}

function defined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

export function mergePolicy(...layers: PolicyLayer[]): CasperPolicy {
  const policy: CasperPolicy = structuredClone(SAFE_DEFAULT_POLICY);

  for (const layer of layers) {
    Object.assign(policy.behavior, defined(layer.behavior ?? {}));
    Object.assign(policy.code, defined(layer.code ?? {}));

    const git = defined(layer.git ?? {});
    if (git.commit) {
      policy.git.commit = git.commit;
    }
    if (git.push) {
      policy.git.push = git.push;
    }
    // Destructive operations always require confirmation. Lower-precedence
    // configuration may tighten policy, but may not remove this restriction.
    policy.git.confirmDestructive = true;
    Object.assign(policy.workspace.isolateWhen, defined(layer.workspace?.isolateWhen ?? {}));
  }

  return policy;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length === value.length ? strings : undefined;
}

export const CACHE_IN_PROJECT_ERROR = "cache is a user setting (~/.casper/config.yaml); a project cannot change how long your prompt cache is kept";

export const BIG_MODEL_IN_PROJECT_ERROR = "repair.bigModelLastTry is a user setting (~/.casper/config.yaml); a project cannot choose to spend on your big model";

function boundedSetting(document: Mapping, section: string, key: string, fallback: number, min: number, max: number): number {
  const settings = document[section];
  if (settings === undefined) return fallback;
  if (!isMapping(settings)) throw new Error(`${section} must be a mapping`);
  const value = settings[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${section}.${key} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/** verification.mode / verification.checks from one layer; undefined when the layer is silent. */
const CHECK_NAME = /^[a-z][a-z0-9-]{0,31}$/;

function verificationSelection(document: Mapping): { mode?: VerificationMode; checks?: CheckName[] } {
  const settings = document.verification;
  if (!isMapping(settings)) return {};
  const { mode, checks } = settings;
  if (mode !== undefined && mode !== null && !VERIFICATION_MODES.some((allowed) => allowed === mode)) {
    throw new Error(`verification.mode must be ${alternatives(VERIFICATION_MODES)}`);
  }
  if (checks !== undefined && checks !== null && (!Array.isArray(checks) || !checks.length
    || !checks.every((name) => typeof name === "string" && CHECK_NAME.test(name)))) {
    throw new Error(`verification.checks must be a nonempty list of ${alternatives(CHECK_NAMES)} or names from verify.checks`);
  }
  return {
    mode: mode ?? undefined,
    checks: checks ? [...new Set(checks as CheckName[])] : undefined,
  } as { mode?: VerificationMode; checks?: CheckName[] };
}

function verificationCommands(document: Mapping): Record<string, string> {
  if (document.verify === undefined) return {};
  if (!isMapping(document.verify)) throw new Error("verify must be a mapping of check names to commands");
  const commands: Record<string, string> = {};
  for (const [name, command] of Object.entries(document.verify)) {
    if (name === "checks") continue; // Named checks: see namedChecks.
    if (!CHECK_NAMES.some((check) => check === name) || typeof command !== "string" || !command.trim()) {
      throw new Error(`Invalid verify.${name}: expected a nonempty typecheck/lint/test/build command, or verify.checks for named checks`);
    }
    commands[name] = command;
  }
  return commands;
}

/** verify.checks: the project's named checks. */
function namedChecks(document: Mapping): ProjectModelOverrides["namedChecks"] {
  if (!isMapping(document.verify) || document.verify.checks === undefined) return undefined;
  const checks = parseNamedChecks(document.verify.checks, "verify.checks");
  return Object.keys(checks).length ? checks : undefined;
}

function verificationScopes(document: Mapping): Partial<Record<ProjectCommand, VerificationScope>> | undefined {
  const scopes = isMapping(document.verification) ? document.verification.scopes : undefined;
  if (scopes === undefined) return undefined;
  if (!isMapping(scopes)) throw new Error("verification.scopes must be a mapping of check names to input scopes");
  for (const [name, scope] of Object.entries(scopes)) {
    if (!CHECK_NAMES.some((check) => check === name) || !isVerificationScope(scope)) {
      throw new Error(`Invalid verification.scopes.${name}: expected bounded, nonempty project-relative inputs and optional exclude paths (no globs)`);
    }
  }
  return scopes as Partial<Record<ProjectCommand, VerificationScope>>;
}

function projectOverrides(document: Mapping): ProjectModelOverrides {
  const project = isMapping(document.project) ? document.project : document;
  const commands = isMapping(project.commands)
    ? Object.fromEntries(
        Object.entries(project.commands).filter((entry): entry is [ProjectCommand, string] =>
          CHECK_NAMES.some((name) => name === entry[0]) && typeof entry[1] === "string"),
      )
    : undefined;
  const architecture = isMapping(project.architecture)
    ? Object.fromEntries(
        Object.entries(project.architecture).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    : undefined;

  const named = namedChecks(document);
  return {
    ...(named ? { namedChecks: named } : {}),
    languages: stringArray(project.languages),
    frameworks: stringArray(project.frameworks),
    packageManager: stringValue(project.packageManager),
    commands: { ...commands, ...verificationCommands(document) },
    verificationScopes: verificationScopes(document),
    architecture,
    conventions: stringArray(project.conventions),
  };
}

const SANDBOX_USER_KEYS = ["enabled", "allowedDomains", "allowWrite", "allowUnixSockets"];
const SANDBOX_PROJECT_KEYS = ["denyRead", "denyWrite"];

function pathList(value: unknown, label: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const list = stringArray(value);
  if (!list || list.some((entry) => !entry.trim())) throw new Error(`${label} must be a list of text`);
  return list.map((entry) => entry.trim());
}

/** `sandbox:` and `shell.keepEnv` from your own file or a profile: `sandbox: off`, or a mapping that adds hosts,
 * write folders and sockets. Later layers add to earlier ones; `off` in any of them turns it off. */
function sandboxUserLayer(document: Mapping, label: string, into: SandboxUserSettings, warnings: string[]): void {
  const value = document.sandbox;
  // Which file turned it off, for the banner and the receipt.
  const setOff = (off: boolean) => { into.off = off; if (off) into.offSource = label; else delete into.offSource; };
  if (value === false || value === "off") setOff(true);
  else if (value === true || value === "on") setOff(false);
  else if (isMapping(value)) {
    for (const key of Object.keys(value)) if (!SANDBOX_USER_KEYS.includes(key)) warnings.push(`${label}: unknown key sandbox.${key} (ignored)`);
    if (value.enabled !== undefined && value.enabled !== null) {
      if (typeof value.enabled !== "boolean") throw new Error(`${label}: sandbox.enabled must be true or false`);
      setOff(!value.enabled);
    }
    const add = (key: "allowedDomains" | "allowWrite" | "allowUnixSockets") => {
      const list = pathList(value[key], `${label}: sandbox.${key}`);
      if (list) into[key] = [...new Set([...(into[key] ?? []), ...list])];
    };
    add("allowedDomains"); add("allowWrite"); add("allowUnixSockets");
  } else if (value !== undefined && value !== null) throw new Error(`${label}: sandbox must be on, off or a mapping`);
  const shell = document.shell;
  if (shell === undefined || shell === null) return;
  if (!isMapping(shell)) throw new Error(`${label}: shell must be a mapping`);
  for (const key of Object.keys(shell)) if (key !== "keepEnv") warnings.push(`${label}: unknown key shell.${key} (ignored)`);
  const keep = pathList(shell.keepEnv, `${label}: shell.keepEnv`);
  if (keep) into.keepEnv = [...new Set([...(into.keepEnv ?? []), ...keep])];
}

const WEB_KEYS = ["enabled", "provider", "searxngUrl"];
const WEB_PROVIDERS = ["duckduckgo", "brave", "searxng"] as const;

/** `web:` from your own file or a profile: on, off, or { enabled, provider, searxngUrl }. Later layers win. */
function webUserLayer(document: Mapping, label: string, into: WebSettings, warnings: string[]): void {
  const value = document.web;
  if (value === undefined || value === null) return;
  if (value === false || value === "off") { into.enabled = false; return; }
  if (value === true || value === "on") { into.enabled = true; return; }
  if (!isMapping(value)) throw new Error(`${label}: web must be on, off or a mapping`);
  for (const key of Object.keys(value)) if (!WEB_KEYS.includes(key)) warnings.push(`${label}: unknown key web.${key} (ignored)`);
  if (value.enabled !== undefined && value.enabled !== null) {
    if (typeof value.enabled !== "boolean") throw new Error(`${label}: web.enabled must be true or false`);
    into.enabled = value.enabled;
  }
  if (value.provider !== undefined && value.provider !== null) {
    if (!WEB_PROVIDERS.some((name) => name === value.provider)) throw new Error(`${label}: web.provider must be ${alternatives([...WEB_PROVIDERS])}`);
    into.provider = value.provider as WebSettings["provider"];
  }
  if (value.searxngUrl !== undefined && value.searxngUrl !== null) {
    let url: URL | undefined;
    try { url = typeof value.searxngUrl === "string" ? new URL(value.searxngUrl) : undefined; } catch { url = undefined; }
    if (!url || (url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      throw new Error(`${label}: web.searxngUrl must be an http or https address without a password`);
    }
    into.searxngUrl = url.href;
  }
}

const READER_KEYS = ["enabled", "untrusted"];

/** `reader:` on, off, or { enabled, untrusted }. Later layers win for enabled and add paths. A project file may only
 * add untrusted paths: turning the reader off or on is your choice. */
function readerLayer(document: Mapping, label: string, into: ReaderSettings, warnings: string[], project: boolean): void {
  const value = document.reader;
  if (value === undefined || value === null) return;
  if (value === false || value === "off" || value === true || value === "on") {
    if (project) { warnings.push(`${label}: reader on or off is your own setting (~/.casper/config.yaml); a project can only add reader.untrusted (ignored)`); return; }
    into.enabled = value === true || value === "on";
    return;
  }
  if (!isMapping(value)) throw new Error(`${label}: reader must be on, off or a mapping`);
  for (const key of Object.keys(value)) if (!READER_KEYS.includes(key)) warnings.push(`${label}: unknown key reader.${key} (ignored)`);
  if (value.enabled !== undefined && value.enabled !== null) {
    if (project) warnings.push(`${label}: reader.enabled is your own setting (~/.casper/config.yaml); a project can only add reader.untrusted (ignored)`);
    else if (typeof value.enabled !== "boolean") throw new Error(`${label}: reader.enabled must be true or false`);
    else into.enabled = value.enabled;
  }
  const paths = pathList(value.untrusted, `${label}: reader.untrusted`);
  if (paths) into.untrusted = [...new Set([...into.untrusted, ...paths])];
}

/** A project can only add denies. Anything that would loosen the sandbox is named and ignored. */
function sandboxProjectLayer(document: Mapping, label: string, warnings: string[]): SandboxProjectSettings {
  const project: SandboxProjectSettings = {};
  if (document.shell !== undefined) warnings.push(`${label}: shell is your own setting (~/.casper/config.yaml); a project can't change it (ignored)`);
  const value = document.sandbox;
  if (value === undefined || value === null) return project;
  if (!isMapping(value)) {
    warnings.push(`${label}: sandbox: ${String(value)} is ignored; a project can't turn the sandbox off, only add denyRead and denyWrite`);
    return project;
  }
  for (const key of Object.keys(value)) {
    if (!SANDBOX_PROJECT_KEYS.includes(key)) warnings.push(`${label}: sandbox.${key} is ignored; a project can only add denyRead and denyWrite`);
  }
  const denyRead = pathList(value.denyRead, `${label}: sandbox.denyRead`);
  const denyWrite = pathList(value.denyWrite, `${label}: sandbox.denyWrite`);
  return { ...(denyRead ? { denyRead } : {}), ...(denyWrite ? { denyWrite } : {}) };
}

export async function loadConfiguration(
  options: LoadConfigurationOptions,
): Promise<LoadedConfiguration> {
  const homeDir = options.homeDir ?? os.homedir();
  const casperHome = path.join(homeDir, ".casper");
  const globalDocument = await readYaml(path.join(casperHome, "config.yaml"));
  const projectDocument = await readYaml(path.join(options.projectRoot, ".casper", "project.yaml"), options.projectRoot);
  const candidates = [
    { source: "options.profileName", value: options.profileName },
    { source: "CASPER_PROFILE", value: process.env.CASPER_PROFILE },
    { source: "project profile", value: projectDocument.profile },
    { source: "global profile", value: globalDocument.profile },
  ];
  let selectedProfile: string | undefined;
  let selectedBy: string | undefined;
  for (const { source, value } of candidates) {
    if (value === undefined) continue;
    if (!isValidProfileName(value)) {
      throw new Error(`Invalid profile name in ${source}: expected 1–64 ASCII letters, digits, underscores, dots or hyphens, starting with a letter or digit`);
    }
    if (selectedProfile === undefined) { selectedProfile = value; selectedBy = source; }
  }
  selectedProfile ??= "default";
  const profileDir = path.join(casperHome, "profiles", selectedProfile);
  const profileDocument = await readYaml(path.join(profileDir, "config.yaml"));
  // A profile the repository picked brings its rules, servers, references and what a project may set anyway; your own
  // settings (sandbox, shell, web, lab, spend and the rest a project can't set) stay those of the profile you chose.
  const ownProfile = typeof globalDocument.profile === "string" ? globalDocument.profile : "default";
  const pickedByProject = selectedBy === "project profile" && selectedProfile !== ownProfile;
  const userProfileDocument = pickedByProject ? await readYaml(path.join(casperHome, "profiles", ownProfile, "config.yaml")) : profileDocument;
  const userProfile = pickedByProject ? ownProfile : selectedProfile;
  const labels = { global: "~/.casper/config.yaml", profile: `profile ${selectedProfile} config.yaml`, userProfile: `profile ${userProfile} config.yaml`, project: ".casper/project.yaml" };
  const profileNotes = pickedByProject && Object.keys(profileDocument).length
    ? [`.casper/project.yaml picked profile ${selectedProfile}: its rules, servers and project settings apply; your own settings (sandbox, shell, web, lab, spend …) stay ${ownProfile === "default" ? "yours" : `those of profile ${ownProfile}`}. CASPER_PROFILE=${selectedProfile} uses all of it.`]
    : [];
  let imports: SkillImport[] = [];
  for (const document of [globalDocument, userProfileDocument, projectDocument]) {
    if (document.skills !== undefined && !isMapping(document.skills)) throw new Error("skills must be a mapping");
    const value = isMapping(document.skills) ? document.skills.imports : undefined;
    if (value === undefined) continue;
    if (document === projectDocument) throw new Error("skills.imports is user/profile-only; projects cannot enable imports");
    if (!Array.isArray(value) || !value.every((entry): entry is SkillImport => SKILL_IMPORTS.includes(entry))) {
      throw new Error("skills.imports must be a list containing only pi, agents, claude, codex");
    }
    imports = [...new Set<SkillImport>(value)];
  }
  // The bundled skills only make the AI more careful, so a repository cannot turn them off.
  if (isMapping(projectDocument.skills) && projectDocument.skills.bundled !== undefined) {
    throw new Error("skills.bundled is a user setting (~/.casper/config.yaml or a profile); a project cannot turn the bundled skills off");
  }
  let bundled = true;
  for (const [document, label] of [[globalDocument, labels.global], [userProfileDocument, labels.userProfile]] as const) {
    const setting = isMapping(document.skills) ? document.skills.bundled : undefined;
    if (setting === undefined || setting === null) continue;
    if (typeof setting !== "boolean") throw new Error(`${label}: skills.bundled must be true or false`);
    bundled = setting;
  }
  // A service runs the project's own command at its root; only the project declares one.
  for (const [document, label] of [[globalDocument, labels.global], [profileDocument, labels.profile]] as const) {
    if (document.services !== undefined) throw new Error(`services is a project setting (.casper/project.yaml); remove it from ${label}`);
    if (document.smoke !== undefined) throw new Error(`smoke is a project setting (.casper/project.yaml); remove it from ${label}`);
    if (document.pages !== undefined) throw new Error(`pages is a project setting (.casper/project.yaml); remove it from ${label}`);
  }
  let maxActive = 6;
  let timeoutMs = 600_000;
  let maxAttempts = 3;
  // Spending on the big model is the user's own choice: a project file never makes it.
  if (isMapping(projectDocument.repair) && projectDocument.repair.bigModelLastTry !== undefined) throw new Error(BIG_MODEL_IN_PROJECT_ERROR);
  if (projectDocument.suggestions !== undefined) throw new Error("suggestions is a user setting (~/.casper/config.yaml); a project cannot turn suggestions on or off");
  if (projectDocument.updates !== undefined) throw new Error("updates is a user setting (~/.casper/config.yaml); a project cannot turn the new-version notice on or off");
  // A side question is a model call at your cost: a project file never turns it on or off.
  if (projectDocument.sideQuestions !== undefined) throw new Error("sideQuestions is a user setting (~/.casper/config.yaml); a project cannot turn side questions on or off");
  // What you pay for caching is your choice too.
  if (projectDocument.cache !== undefined) throw new Error(CACHE_IN_PROJECT_ERROR);
  let bigModelLastTry: boolean | undefined;
  let suggestions: boolean | undefined;
  let updates: boolean | undefined;
  let sideQuestions: boolean | undefined;
  let cache: PromptCacheSetting | undefined;
  // How much shows on your screen is yours, not a repository's.
  if (projectDocument.display !== undefined) throw new Error("display is a user setting (~/.casper/config.yaml); a project cannot change what shows on your screen");
  let display: DisplayLevel | undefined;
  // Showing the AI page screenshots spends your tokens: a project file never turns it on.
  if (projectDocument.showPages !== undefined) throw new Error("showPages is a user setting (~/.casper/config.yaml); a project cannot decide what the AI is shown at your cost");
  let showPages: ShowPagesSetting | undefined;
  for (const [document, label] of [[globalDocument, labels.global], [userProfileDocument, labels.userProfile]] as const) {
    if (document.showPages !== undefined && document.showPages !== null) {
      // YAML reads a bare on/off as text and true/false as booleans; both mean the same.
      const value = document.showPages === true ? "on" : document.showPages === false ? "off" : document.showPages;
      if (!SHOW_PAGES_SETTINGS.some((setting) => setting === value)) throw new Error(`${label}: showPages must be ${alternatives(SHOW_PAGES_SETTINGS)}`);
      showPages = value as ShowPagesSetting;
    }
    const setting = isMapping(document.repair) ? document.repair.bigModelLastTry : undefined;
    if (setting !== undefined && setting !== null) {
      if (typeof setting !== "boolean") throw new Error(`${label}: repair.bigModelLastTry must be true or false`);
      bigModelLastTry = setting;
    }
    if (document.suggestions !== undefined && document.suggestions !== null) {
      if (typeof document.suggestions !== "boolean") throw new Error(`${label}: suggestions must be true or false`);
      suggestions = document.suggestions;
    }
    if (document.updates !== undefined && document.updates !== null) {
      // YAML reads a bare `off` as text, but it means the same as false.
      const value = document.updates === "off" ? false : document.updates === "on" ? true : document.updates;
      if (typeof value !== "boolean") throw new Error(`${label}: updates must be true or false`);
      updates = value;
    }
    if (document.sideQuestions !== undefined && document.sideQuestions !== null) {
      const value = document.sideQuestions === "off" ? false : document.sideQuestions === "on" ? true : document.sideQuestions;
      if (typeof value !== "boolean") throw new Error(`${label}: sideQuestions must be true or false`);
      sideQuestions = value;
    }
    if (document.cache !== undefined && document.cache !== null) {
      // YAML reads a bare `off` as text, but `cache: false` means the same.
      const value = document.cache === false ? "off" : document.cache;
      if (!PROMPT_CACHE_SETTINGS.some((setting) => setting === value)) throw new Error(`${label}: cache must be ${alternatives(PROMPT_CACHE_SETTINGS)}`);
      cache = value as PromptCacheSetting;
    }
    if (document.display !== undefined && document.display !== null) {
      if (!DISPLAY_LEVELS.some((level) => level === document.display)) throw new Error(`${label}: display must be ${alternatives(DISPLAY_LEVELS)}`);
      display = document.display as DisplayLevel;
    }
  }
  // Builders spend your tokens: on unless you turn them off; a project file may turn them off, never on for you.
  let build = true;
  for (const [document, label] of [[globalDocument, labels.global], [userProfileDocument, labels.userProfile], [projectDocument, labels.project]] as const) {
    if (document.delegate === undefined || document.delegate === null) continue;
    if (!isMapping(document.delegate)) throw new Error(`${label}: delegate must be a mapping (delegate.build)`);
    const value = document.delegate.build === "off" ? false : document.delegate.build === "on" ? true : document.delegate.build;
    if (value === undefined || value === null) continue;
    if (typeof value !== "boolean") throw new Error(`${label}: delegate.build must be true or false`);
    if (document === projectDocument) build &&= value;
    else build = value;
  }
  // What a task may spend before Casper says so or asks: the user's money, so a project file never sets it.
  if (projectDocument.spend !== undefined) throw new Error("spend is a user setting (~/.casper/config.yaml); a project cannot change spend limits");
  const spend: SpendLimits = { ...DEFAULT_SPEND_LIMITS };
  for (const [document, label] of [[globalDocument, labels.global], [userProfileDocument, labels.userProfile]] as const) {
    if (document.spend === undefined || document.spend === null) continue;
    if (!isMapping(document.spend)) throw new Error(`${label}: spend must be a mapping (spend.noteAt, spend.pauseAt)`);
    for (const key of ["noteAt", "pauseAt"] as const) {
      const value = document.spend[key];
      if (value === undefined || value === null) continue;
      if (value === false) { delete spend[key]; continue; }
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 100_000) {
        throw new Error(`${label}: spend.${key} must be a dollar amount above 0, or false to turn it off`);
      }
      spend[key] = value;
    }
  }
  let mode: VerificationMode | undefined;
  let checks: CheckName[] | undefined;
  let review: boolean | undefined;
  let acceptance: boolean | "warn" | undefined;
  let checklist: boolean | undefined;
  let e2e: boolean | undefined;
  for (const document of [globalDocument, profileDocument, projectDocument]) {
    const e2eSetting = isMapping(document.verification) ? document.verification.e2e : undefined;
    if (e2eSetting !== undefined && e2eSetting !== null && typeof e2eSetting !== "boolean") throw new Error("verification.e2e must be true or false");
    e2e = typeof e2eSetting === "boolean" ? e2eSetting : e2e;
    const reviewSetting = isMapping(document.verification) ? document.verification.review : undefined;
    if (reviewSetting !== undefined && typeof reviewSetting !== "boolean") throw new Error("verification.review must be true or false");
    review = reviewSetting ?? review;
    const acceptanceSetting = isMapping(document.verification) ? document.verification.acceptance : undefined;
    if (acceptanceSetting !== undefined && typeof acceptanceSetting !== "boolean" && acceptanceSetting !== "warn") throw new Error("verification.acceptance must be true, false or warn");
    acceptance = acceptanceSetting ?? acceptance;
    const checklistSetting = isMapping(document.verification) ? document.verification.checklist : undefined;
    if (checklistSetting !== undefined && typeof checklistSetting !== "boolean") throw new Error("verification.checklist must be true or false");
    checklist = checklistSetting ?? checklist;
    timeoutMs = boundedSetting(document, "verification", "timeoutMs", timeoutMs, 1, 3_600_000);
    const selection = verificationSelection(document);
    // Named checks belong to one project: your own config picking one would break every other project.
    const foreign = document === projectDocument ? undefined : selection.checks?.find((name) => !CHECK_NAMES.some((check) => check === name));
    if (foreign) {
      throw new Error(`${document === globalDocument ? labels.global : labels.profile}: verification.checks can only pick ${alternatives(CHECK_NAMES)} here; pick ${foreign} in that project's .casper/project.yaml`);
    }
    mode = selection.mode ?? mode;
    checks = selection.checks ?? checks;
    maxAttempts = boundedSetting(document, "repair", "maxAttempts", maxAttempts, 0, 10);
    const value = isMapping(document.skills) ? document.skills.maxActive : undefined;
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 32) {
      throw new Error("skills.maxActive must be an integer between 0 and 32");
    }
    maxActive = value;
  }

  const services = parseServices(projectDocument.services, labels.project);
  const overrides = projectOverrides(projectDocument);
  if (checks) {
    // A selected name must be a built-in check or one the project named; lab checks never run on their own.
    const declared = overrides.namedChecks ?? {};
    const labs = new Set(labNamedChecks(declared));
    for (const name of checks) {
      if (labs.has(name)) throw new Error(`verification.checks: ${name} is a lab check; lab checks run only when you start them (/verify ${name})`);
      if (!CHECK_NAMES.some((check) => check === name) && !declared[name]) {
        throw new Error(`verification.checks: ${name} is not a check. Use ${alternatives(CHECK_NAMES)} or a name from verify.checks in .casper/project.yaml`);
      }
    }
  }
  if (projectDocument.lab !== undefined) throw new Error(LAB_IN_PROJECT_ERROR);
  const pages = parsePagesSetting(projectDocument.pages, labels.project);
  const sandboxWarnings: string[] = [];
  const sandboxUser: SandboxUserSettings = {};
  sandboxUserLayer(globalDocument, labels.global, sandboxUser, sandboxWarnings);
  sandboxUserLayer(userProfileDocument, labels.userProfile, sandboxUser, sandboxWarnings);
  const sandboxProject = sandboxProjectLayer(projectDocument, labels.project, sandboxWarnings);
  // What the AI may reach on the web, and which paid provider it uses, is your choice, never a repository's.
  if (projectDocument.web !== undefined) throw new Error("web is a user setting (~/.casper/config.yaml); a project cannot turn web lookups on or off or pick a search provider");
  const web: WebSettings = { ...DEFAULT_WEB };
  webUserLayer(globalDocument, labels.global, web, sandboxWarnings);
  webUserLayer(userProfileDocument, labels.userProfile, web, sandboxWarnings);
  if (web.provider === "searxng" && !web.searxngUrl) throw new Error(`${labels.global}: web.provider searxng needs web.searxngUrl (your SearXNG address)`);
  const reader: ReaderSettings = { ...DEFAULT_READER, untrusted: [] };
  readerLayer(globalDocument, labels.global, reader, sandboxWarnings, false);
  readerLayer(userProfileDocument, labels.userProfile, reader, sandboxWarnings, false);
  // A profile the repository picked is held like a project file: it can add untrusted paths, not turn the reader off.
  if (pickedByProject) readerLayer(profileDocument, labels.profile, reader, sandboxWarnings, true);
  readerLayer(projectDocument, labels.project, reader, sandboxWarnings, true);
  const lab = mergeLabSettings(parseLabSettings(globalDocument.lab, "user", `${labels.global}: lab`), parseLabSettings(userProfileDocument.lab, "profile", `${labels.userProfile}: lab`));
  return {
    skills: { maxActive, imports, bundled },
    verification: { timeoutMs, ...(mode ? { mode } : {}), ...(checks ? { checks } : {}), ...(review !== undefined ? { review } : {}), ...(acceptance !== undefined ? { acceptance } : {}), ...(e2e !== undefined ? { e2e } : {}),
      ...(checklist !== undefined ? { checklist } : {}) },
    repair: { maxAttempts, ...(bigModelLastTry !== undefined ? { bigModelLastTry } : {}) },
    ...(suggestions !== undefined ? { suggestions } : {}),
    ...(updates !== undefined ? { updates } : {}),
    ...(sideQuestions !== undefined ? { sideQuestions } : {}),
    ...(cache ? { cache } : {}),
    ...(display ? { display } : {}),
    ...(showPages ? { showPages } : {}),
    ...(build ? {} : { delegate: { build: false } }),
    spend,
    services,
    smoke: parseSmoke(projectDocument.smoke, Object.keys(services), labels.project),
    ...(pages ? { pages } : {}),
    visualize: resolveVisualizationSettings({
      projectName: path.basename(options.projectRoot),
      homeDir,
      layers: [
        { document: globalDocument, source: "global" },
        { document: profileDocument, source: "profile" },
        { document: projectDocument, source: "project" },
      ],
    }),
    profileName: selectedProfile,
    policy: mergePolicy(
      policyLayer(globalDocument, labels.global),
      policyLayer(profileDocument, labels.profile),
      policyLayer(projectDocument, labels.project),
    ),
    sandbox: { user: sandboxUser, project: sandboxProject },
    web,
    reader,
    warnings: [
      ...profileNotes,
      ...sandboxWarnings,
      ...unknownKeys(globalDocument, labels.global),
      ...unknownKeys(profileDocument, labels.profile),
      ...unknownKeys(projectDocument, labels.project),
    ],
    profileRules: await readOptionalText(path.join(profileDir, "rules.md")),
    projectRules: (await readProjectFile(options.projectRoot, ".casper/rules.md", MAX_PROJECT_RULES_BYTES))?.trim() || null,
    projectOverrides: overrides,
    ...(lab ? { lab } : {}),
    ...(parseLabSettings(userProfileDocument.lab, "profile") ? { labProfile: userProfile } : {}),
  };
}
