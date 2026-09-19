import os from "node:os";
import { loadConfiguration, type CasperPolicy } from "../config/load";
import type { ProjectInfo } from "./inspect";
import { loadProjectModel, type ProjectModel } from "./model";

export interface ProjectContext {
  info: ProjectInfo;
  model: ProjectModel;
  profileName: string;
  policy: CasperPolicy;
  skills: { maxActive: number };
  verification: { timeoutMs: number };
  repair: { maxAttempts: number };
  rules: {
    profile: string | null;
    project: string | null;
  };
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
    model,
    profileName: configuration.profileName,
    policy: configuration.policy,
    skills: configuration.skills,
    verification: configuration.verification,
    repair: configuration.repair,
    rules: {
      profile: configuration.profileRules,
      project: configuration.projectRules,
    },
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
    `- git commit: ${policy.git.commit}`,
    `- git push: ${policy.git.push}`,
    "- confirm destructive operations: true",
  ];

  if (rules.profile) {
    sections.push("Profile rules:", rules.profile);
  }
  if (rules.project) {
    sections.push("Project rules (higher precedence than profile rules):", rules.project);
  }

  return sections.join("\n");
}
