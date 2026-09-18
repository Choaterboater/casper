import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import type { ProjectModelOverrides } from "../project/model";

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
}

export interface LoadedConfiguration {
  profileName: string;
  policy: CasperPolicy;
  profileRules: string | null;
  projectRules: string | null;
  projectOverrides: ProjectModelOverrides;
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

function projectOverrides(document: Mapping): ProjectModelOverrides {
  const project = isMapping(document.project) ? document.project : document;
  const commands = isMapping(project.commands)
    ? Object.fromEntries(
        Object.entries(project.commands).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
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
    commands,
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
  const selectedProfile =
    stringValue(options.profileName) ??
    stringValue(process.env.CASPER_PROFILE) ??
    stringValue(projectDocument.profile) ??
    stringValue(globalDocument.profile) ??
    "default";
  const profileDir = path.join(casperHome, "profiles", selectedProfile);
  const profileDocument = await readYaml(path.join(profileDir, "config.yaml"));

  return {
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
