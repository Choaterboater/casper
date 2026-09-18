import type { ProjectContext } from "../project/context";

function displayList(values: string[]): string {
  return values.length ? values.join(" · ") : "(not detected)";
}

function displayCommand(command: string | undefined): string {
  return command ?? "(not detected)";
}

export function renderProjectSummary(context: ProjectContext): string {
  const { info, model } = context;
  return [
    ` project   ${model.project.name}`,
    ` stack     ${displayList([...model.languages, ...model.frameworks])}`,
    ` package   ${model.packageManager ?? "(not detected)"}`,
    ` build     ${displayCommand(model.commands.build)}`,
    ` test      ${displayCommand(model.commands.test)}`,
    ` profile   ${context.profileName}`,
    ` branch    ${info.gitBranch ?? "(no git branch)"}`,
  ].join("\n");
}

export function renderBanner(context: ProjectContext): string {
  return [
    "      .-.",
    "     (o o)",
    "     | O \\",
    "      \\   \\",
    "       `~~~'",
    "",
    "      CASPER",
    "your coding companion",
    "",
    renderProjectSummary(context),
    " runtime   pi",
    "",
  ].join("\n");
}
