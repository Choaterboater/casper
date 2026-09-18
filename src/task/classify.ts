import type { ProjectCommand, ProjectModel } from "../project/model";

export type TaskIntent =
  | "fix"
  | "implement"
  | "refactor"
  | "test"
  | "document"
  | "configure"
  | "inspect"
  | "general";

export interface TaskClassification {
  intent: TaskIntent;
  mode: "read" | "modify";
  verification: ProjectCommand[];
}

const INTENT_PATTERNS: Array<[TaskIntent, RegExp]> = [
  ["fix", /\b(fix|bug|broken|failing|failure|error|regression|debug)\b/i],
  ["refactor", /\b(refactor|restructure|rename|extract|simplif(?:y|ication)|clean up)\b/i],
  ["test", /\b(test|spec|coverage|verify|typecheck|lint)\b/i],
  ["document", /\b(document|documentation|readme|docs|comment|explain)\b/i],
  ["configure", /\b(configure|configuration|setup|set up|install|upgrade|dependency)\b/i],
  ["implement", /\b(add|build|create|implement|introduce|support|feature|change|update)\b/i],
  ["inspect", /\b(inspect|review|summarize|analyse|analyze|find|locate|show|list|what|why|how)\b/i],
];

export function classifyTask(text: string): TaskClassification {
  const intent = INTENT_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] ?? "general";
  const mode = intent === "inspect" || intent === "general" ? "read" : "modify";
  const verification: ProjectCommand[] =
    intent === "document" || intent === "inspect" || intent === "general"
      ? []
      : intent === "test"
        ? ["test"]
        : ["typecheck", "lint", "test", "build"];

  return { intent, mode, verification };
}

export function formatTaskPrompt(
  request: string,
  classification: TaskClassification,
  model: ProjectModel,
): string {
  const availableChecks = classification.verification
    .filter((name) => model.commands[name])
    .map((name) => `${name}=${model.commands[name]}`);

  return [
    "Casper task classification:",
    `- intent: ${classification.intent}`,
    `- mode: ${classification.mode}`,
    `- available relevant checks: ${availableChecks.length ? availableChecks.join("; ") : "none detected"}`,
    "",
    "User request:",
    request,
  ].join("\n");
}
