import type { ProjectContext } from "../project/context";

function displayList(values: string[]): string {
  return values.length ? values.join(" · ") : "not detected";
}

function displayCommand(command: string | undefined): string {
  return command ?? "not detected";
}

export function renderProjectSummary(context: ProjectContext): string {
  const { info, model } = context;
  return [
    `Project: ${model.project.name}`,
    `Stack: ${displayList([...model.languages, ...model.frameworks])}`,
    `Package manager: ${model.packageManager ?? "not detected"}`,
    `Build: ${displayCommand(model.commands.build)}`,
    `Test: ${displayCommand(model.commands.test)}`,
    `Profile: ${context.profileName}`,
    `Branch: ${info.gitBranch ?? "no git branch"}`,
  ].join("\n");
}

export function renderBanner(context: ProjectContext): string {
  return [
    "CASPER · coding companion",
    `Project: ${context.model.project.name}`,
    `Branch: ${context.info.gitBranch ?? "no git branch"} · Profile: ${context.profileName}`,
    "Describe a task to begin. /help for commands · /model to choose a model · /login for credentials.",
    "",
  ].join("\n");
}
