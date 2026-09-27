import { readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { isValidProfileName } from "./profile";
import { readReferenceFile } from "../references/files";
import type { ProjectCommand, ProjectModelOverrides } from "../project/model";
import { CHECK_NAMES } from "../verify/evidence";
import { SKILL_IMPORTS, type SkillImport } from "../skills/registry";
import { isVerificationScope, type VerificationScope } from "../verify/scope";
import { VERIFICATION_MODES, type VerificationMode, type VerificationSettings } from "../verify/mode";
import { resolveVisualizationSettings, type VisualizationSettings } from "../visualize/router";
import { parseServices, type ServiceSpec } from "../services/config";
import { parseSmoke, type SmokeCheck } from "../services/smoke";

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
  skills: { maxActive: number; imports: SkillImport[] };
  verification: VerificationSettings;
  repair: { maxAttempts: number };
  visualize: VisualizationSettings;
  /** Declared managed services (project layer only), by name. */
  services: Record<string, ServiceSpec>;
  /** Configured smoke checks against those services (project layer only). */
  smoke: SmokeCheck[];
  /** Unknown keys, by file; shown at startup and otherwise ignored. */
  warnings: string[];
}

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
  if (!inside || inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
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
  "conventions", "verify", "verification", "repair", "skills", "visualize", "policy", "services", "smoke", ...Object.keys(POLICY_KEYS)]);

/** Typos used to fall back silently to the defaults; the loader names them instead. */
function unknownKeys(document: Mapping, label: string): string[] {
  const unknown: string[] = [];
  const check = (value: unknown, prefix: string, known: readonly string[]) => {
    if (isMapping(value)) for (const key of Object.keys(value)) if (!known.includes(key)) unknown.push(`${prefix}${key}`);
  };
  check(document, "", [...TOP_LEVEL_KEYS]);
  check(document.policy, "policy.", Object.keys(POLICY_KEYS));
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
function verificationSelection(document: Mapping): { mode?: VerificationMode; checks?: ProjectCommand[] } {
  const settings = document.verification;
  if (!isMapping(settings)) return {};
  const { mode, checks } = settings;
  if (mode !== undefined && mode !== null && !VERIFICATION_MODES.some((allowed) => allowed === mode)) {
    throw new Error(`verification.mode must be ${alternatives(VERIFICATION_MODES)}`);
  }
  if (checks !== undefined && checks !== null && (!Array.isArray(checks) || !checks.length
    || !checks.every((name) => CHECK_NAMES.some((check) => check === name)))) {
    throw new Error(`verification.checks must be a nonempty list of ${alternatives(CHECK_NAMES)}`);
  }
  return {
    mode: mode ?? undefined,
    checks: checks ? [...new Set(checks as ProjectCommand[])] : undefined,
  } as { mode?: VerificationMode; checks?: ProjectCommand[] };
}

function verificationCommands(document: Mapping): Record<string, string> {
  if (document.verify === undefined) return {};
  if (!isMapping(document.verify)) throw new Error("verify must be a mapping of check names to commands");
  for (const [name, command] of Object.entries(document.verify)) {
    if (!CHECK_NAMES.some((check) => check === name) || typeof command !== "string" || !command.trim()) {
      throw new Error(`Invalid verify.${name}: expected a nonempty typecheck/lint/test/build command`);
    }
  }
  return document.verify as Record<string, string>;
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

  return {
    languages: stringArray(project.languages),
    frameworks: stringArray(project.frameworks),
    packageManager: stringValue(project.packageManager),
    commands: { ...commands, ...verificationCommands(document) },
    verificationScopes: verificationScopes(document),
    architecture,
    conventions: stringArray(project.conventions),
  };
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
  for (const { source, value } of candidates) {
    if (value === undefined) continue;
    if (!isValidProfileName(value)) {
      throw new Error(`Invalid profile name in ${source}: expected 1–64 ASCII letters, digits, underscores, dots or hyphens, starting with a letter or digit`);
    }
    selectedProfile ??= value;
  }
  selectedProfile ??= "default";
  const profileDir = path.join(casperHome, "profiles", selectedProfile);
  const profileDocument = await readYaml(path.join(profileDir, "config.yaml"));
  const labels = { global: "~/.casper/config.yaml", profile: `profile ${selectedProfile} config.yaml`, project: ".casper/project.yaml" };
  let imports: SkillImport[] = [];
  for (const document of [globalDocument, profileDocument, projectDocument]) {
    if (document.skills !== undefined && !isMapping(document.skills)) throw new Error("skills must be a mapping");
    const value = isMapping(document.skills) ? document.skills.imports : undefined;
    if (value === undefined) continue;
    if (document === projectDocument) throw new Error("skills.imports is user/profile-only; projects cannot enable imports");
    if (!Array.isArray(value) || !value.every((entry): entry is SkillImport => SKILL_IMPORTS.includes(entry))) {
      throw new Error("skills.imports must be a list containing only pi, agents, claude, codex");
    }
    imports = [...new Set<SkillImport>(value)];
  }
  // A service runs the project's own command at its root; only the project declares one.
  for (const [document, label] of [[globalDocument, labels.global], [profileDocument, labels.profile]] as const) {
    if (document.services !== undefined) throw new Error(`services is a project setting (.casper/project.yaml); remove it from ${label}`);
    if (document.smoke !== undefined) throw new Error(`smoke is a project setting (.casper/project.yaml); remove it from ${label}`);
  }
  let maxActive = 6;
  let timeoutMs = 600_000;
  let maxAttempts = 3;
  let mode: VerificationMode | undefined;
  let checks: ProjectCommand[] | undefined;
  let review: boolean | undefined;
  let acceptance: boolean | "warn" | undefined;
  let checklist: boolean | undefined;
  for (const document of [globalDocument, profileDocument, projectDocument]) {
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
  return {
    skills: { maxActive, imports },
    verification: { timeoutMs, ...(mode ? { mode } : {}), ...(checks ? { checks } : {}), ...(review !== undefined ? { review } : {}), ...(acceptance !== undefined ? { acceptance } : {}),
      ...(checklist !== undefined ? { checklist } : {}) },
    repair: { maxAttempts },
    services,
    smoke: parseSmoke(projectDocument.smoke, Object.keys(services), labels.project),
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
    warnings: [
      ...unknownKeys(globalDocument, labels.global),
      ...unknownKeys(profileDocument, labels.profile),
      ...unknownKeys(projectDocument, labels.project),
    ],
    profileRules: await readOptionalText(path.join(profileDir, "rules.md")),
    projectRules: (await readProjectFile(options.projectRoot, ".casper/rules.md", MAX_PROJECT_RULES_BYTES))?.trim() || null,
    projectOverrides: projectOverrides(projectDocument),
  };
}
