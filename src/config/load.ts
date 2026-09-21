import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { isValidProfileName } from "./profile";
import type { ProjectCommand, ProjectModelOverrides } from "../project/model";
import { CHECK_NAMES } from "../verify/evidence";
import { SKILL_IMPORTS, type SkillImport } from "../skills/registry";
import { isVerificationScope, type VerificationScope } from "../verify/scope";
import { resolveVisualizationSettings, type VisualizationSettings } from "../visualize/router";

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
  verification: { timeoutMs: number };
  repair: { maxAttempts: number };
  visualize: VisualizationSettings;
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

async function readYaml(filePath: string): Promise<Mapping> {
  let source: string;

  try {
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

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function policyLayer(document: Mapping): PolicyLayer {
  const nested = isMapping(document.policy) ? document.policy : {};
  const section = (name: string): Mapping => {
    const directValue = document[name];
    const nestedValue = nested[name];
    return {
      ...(isMapping(directValue) ? directValue : {}),
      ...(isMapping(nestedValue) ? nestedValue : {}),
    };
  };
  const behavior = section("behavior");
  const code = section("code");
  const git = section("git");
  const workspace = section("workspace");
  const isolateWhen = isMapping(workspace.isolateWhen) ? workspace.isolateWhen : {};

  return {
    behavior: {
      autonomy:
        behavior.autonomy === "low" || behavior.autonomy === "medium" || behavior.autonomy === "high"
          ? behavior.autonomy
          : undefined,
      askQuestions:
        behavior.askQuestions === "beforeChanges" || behavior.askQuestions === "onlyWhenBlocked"
          ? behavior.askQuestions
          : undefined,
      inspectBeforeEditing: booleanValue(behavior.inspectBeforeEditing),
    },
    code: {
      reuseExistingPatterns: booleanValue(code.reuseExistingPatterns),
      preserveArchitecture: booleanValue(code.preserveArchitecture),
      avoidOverengineering: booleanValue(code.avoidOverengineering),
      avoidUnnecessaryDependencies: booleanValue(code.avoidUnnecessaryDependencies),
      preferSmallChanges: booleanValue(code.preferSmallChanges),
    },
    git: {
      commit:
        git.commit === "never" || git.commit === "neverUnlessRequested" ? git.commit : undefined,
      push: git.push === "never" || git.push === "neverUnlessRequested" ? git.push : undefined,
      confirmDestructive: booleanValue(git.confirmDestructive),
    },
    workspace: {
      isolateWhen: {
        parallelAgents: booleanValue(isolateWhen.parallelAgents),
        riskyRefactor: booleanValue(isolateWhen.riskyRefactor),
        experimentalBranch: booleanValue(isolateWhen.experimentalBranch),
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
  const projectDocument = await readYaml(path.join(options.projectRoot, ".casper", "project.yaml"));
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
  let maxActive = 6;
  let timeoutMs = 120_000;
  let maxAttempts = 3;
  for (const document of [globalDocument, profileDocument, projectDocument]) {
    timeoutMs = boundedSetting(document, "verification", "timeoutMs", timeoutMs, 1, 3_600_000);
    maxAttempts = boundedSetting(document, "repair", "maxAttempts", maxAttempts, 0, 10);
    const value = isMapping(document.skills) ? document.skills.maxActive : undefined;
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 32) {
      throw new Error("skills.maxActive must be an integer between 0 and 32");
    }
    maxActive = value;
  }

  return {
    skills: { maxActive, imports },
    verification: { timeoutMs },
    repair: { maxAttempts },
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
      policyLayer(globalDocument),
      policyLayer(profileDocument),
      policyLayer(projectDocument),
    ),
    profileRules: await readOptionalText(path.join(profileDir, "rules.md")),
    projectRules: await readOptionalText(path.join(options.projectRoot, ".casper", "rules.md")),
    projectOverrides: projectOverrides(projectDocument),
  };
}
