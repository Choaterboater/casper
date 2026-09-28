import os from "node:os";
import { loadConfiguration, type CasperPolicy, type GitActionPolicy, type LoadedConfiguration } from "../config/load";
import type { VisualizationSettings } from "../visualize/router";
import type { ProjectInfo } from "./inspect";
import { loadProjectModel, projectStateDirectory, type ProjectModel } from "./model";

export interface ProjectContext {
  info: ProjectInfo;
  stateDirectory: string;
  model: ProjectModel;
  profileName: string;
  policy: CasperPolicy;
  skills: LoadedConfiguration["skills"];
  verification: LoadedConfiguration["verification"];
  repair: { maxAttempts: number };
  visualize: VisualizationSettings;
  /** Managed services declared in .casper/project.yaml (see docs/SERVICES.md). */
  services?: LoadedConfiguration["services"];
  /** Configured smoke checks, run after every change (see docs/VERIFICATION.md). */
  smoke?: LoadedConfiguration["smoke"];
  rules: {
    profile: string | null;
    project: string | null;
  };
  /** Configuration keys that were ignored, by file (see LoadedConfiguration.warnings). */
  warnings?: string[];
}

export interface LoadProjectContextOptions {
  homeDir?: string;
  profileName?: string;
}

export async function loadProjectContext(
  info: ProjectInfo,
  options: LoadProjectContextOptions = {},
): Promise<ProjectContext> {
  const homeDir = options.homeDir ?? os.homedir();
  const configuration = await loadConfiguration({
    projectRoot: info.root,
    homeDir,
    profileName: options.profileName,
  });
  const model = await loadProjectModel(info, {
    homeDir,
    overrides: configuration.projectOverrides,
  });

  return {
    info,
    stateDirectory: projectStateDirectory(info.root, homeDir),
    model,
    profileName: configuration.profileName,
    policy: configuration.policy,
    skills: configuration.skills,
    verification: configuration.verification,
    repair: configuration.repair,
    visualize: configuration.visualize,
    services: configuration.services,
    smoke: configuration.smoke,
    rules: {
      profile: configuration.profileRules,
      project: configuration.projectRules,
    },
    warnings: configuration.warnings,
  };
}

function list(values: string[]): string {
  return values.length ? values.join(", ") : "not detected";
}

function commands(model: ProjectModel): string {
  const entries = Object.entries(model.commands);
  return entries.length
    ? entries.map(([name, command]) => `${name}=${command}`).join("; ")
    : "not detected";
}

function gitRule(policy: GitActionPolicy): string {
  return policy === "never" ? "never" : "only when the user asks";
}

export function formatProjectContext(context: ProjectContext): string {
  const { model, policy, rules } = context;
  const sections = [
    "Casper project context (deterministically detected and cached):",
    `- project: ${model.project.name}`,
    `- root: ${model.project.root}`,
    `- languages: ${list(model.languages)}`,
    `- frameworks: ${list(model.frameworks)}`,
    `- package manager: ${model.packageManager ?? "not detected"}`,
    `- commands: ${commands(model)}`,
    `- selected profile: ${context.profileName}`,
    "Casper policy:",
    `- autonomy: ${policy.behavior.autonomy}`,
    `- ask questions: ${policy.behavior.askQuestions}`,
    `- inspect before editing: ${policy.behavior.inspectBeforeEditing}`,
    `- prefer small changes: ${policy.code.preferSmallChanges}`,
    `- preserve architecture: ${policy.code.preserveArchitecture}`,
    `- avoid unnecessary dependencies: ${policy.code.avoidUnnecessaryDependencies}`,
    // Instructions to the model, not rules Casper enforces: bash can still run git or rm.
    `- git commit: ${gitRule(policy.git.commit)}`,
    `- git push: ${gitRule(policy.git.push)}`,
    "- destructive operations (deleting files, git reset, force-push): ask the user first",
    `- isolate parallel agents: ${policy.workspace.isolateWhen.parallelAgents}`,
    `- isolate risky refactors: ${policy.workspace.isolateWhen.riskyRefactor}`,
    `- isolate experimental branches: ${policy.workspace.isolateWhen.experimentalBranch}`,
  ];

  if (rules.profile) {
    sections.push("Profile rules:", rules.profile);
  }
  if (rules.project) {
    sections.push("Project rules (higher precedence than profile rules):", rules.project);
  }
  const structure = Object.entries(model.architecture);
  if (structure.length || model.conventions.length) {
    sections.push("Repository structure (from the tree, not a skill):");
    for (const [name, value] of structure) sections.push(`- ${name}: ${value}`);
    for (const convention of model.conventions) sections.push(`- ${convention}`);
  }

  return sections.join("\n");
}
