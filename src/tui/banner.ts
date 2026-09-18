import type { ProjectInfo } from "../project/inspect";

export function renderBanner(project: ProjectInfo): string {
  const branch = project.gitBranch ?? "(no git branch)";

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
    ` project  ${project.name}`,
    ` root     ${project.root}`,
    ` branch   ${branch}`,
    " runtime  pi",
    "",
  ].join("\n");
}
