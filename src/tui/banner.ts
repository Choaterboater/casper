import type { ProjectContext } from "../project/context";
import { CASPER_VERSION } from "../version";

function displayList(values: string[]): string {
  return values.length ? values.join(" · ") : "(not detected)";
}

export function renderProjectSummary(context: ProjectContext): string {
  const { info, model } = context;
  return [
    ` project   ${model.project.name}`,
    ` stack     ${displayList([...model.languages, ...model.frameworks])}`,
    ` package   ${model.packageManager ?? "(not detected)"}`,
    ` build     ${model.commands.build ?? "(not detected)"}`,
    ` test      ${model.commands.test ?? "(not detected)"}`,
    ` profile   ${context.profileName}`,
    ` branch    ${info.gitBranch ?? "(no git branch)"}`,
  ].join("\n");
}

export function renderBanner(context: ProjectContext): string {
  return [
    `CASPER ${CASPER_VERSION} · your coding companion`,
    ` project   ${context.model.project.name} · branch ${context.info.gitBranch ?? "(no git branch)"} · profile ${context.profileName}`,
    " /help · /status · /login · /model",
    "",
  ].join("\n");
}
