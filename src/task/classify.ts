import type { ProjectCommand, ProjectModel } from "../project/model";
import { CHECK_NAMES } from "../verify/evidence";

export type TaskIntent =
  | "fix"
  | "implement"
  | "refactor"
  | "test"
  | "document"
  | "configure"
  | "inspect"
  | "visualize"
  | "general";

export interface TaskClassification {
  intent: TaskIntent;
  mode: "read" | "modify";
  /** Legacy lexical hint only; never selects or authorizes command execution. */
  verification: ProjectCommand[];
}

const INTENT_PATTERNS: Array<[TaskIntent, RegExp]> = [
  ["fix", /\b(fix|bug|broken|failing|failure|error|regression|debug)\b/i],
  ["refactor", /\b(refactor|restructure|rename|extract|simplif(?:y|ication)|clean up)\b/i],
  ["test", /\b(test|spec|coverage|verify|typecheck|lint)\b/i],
  ["visualize", /\b(visuali[sz]e|diagram|mind ?map|flowchart|dependency graph|map out|draw|chart)\b/i],
  ["document", /\b(document|documentation|readme|docs|comment|explain)\b/i],
  ["configure", /\b(configure|configuration|setup|set up|install|upgrade|dependency)\b/i],
  ["implement", /\b(add|build|create|implement|introduce|support|feature|change|update)\b/i],
  ["inspect", /\b(inspect|review|summarize|analyse|analyze|find|locate|show|list|what|why|how)\b/i],
];

export function classifyTask(text: string): TaskClassification {
  // Explicit visualization actions take priority over the subject being described.
  const visualizationRequest = /^(?:(?:can|could|would) you\s+)?(?:please\s+)?(?:visuali[sz]e|map out|draw|chart|diagram|mind ?map|flowchart)\b|^(?:(?:can|could|would) you\s+)?(?:please\s+)?(?:show|give|create|make|generate|produce)\b.{0,100}\b(?:diagram|mind ?map|flowchart|dependency graph|chart)\b|\bas (?:a |an )?(?:diagram|mind ?map|flowchart|dependency graph)\b/i.test(text.trim());
  const modificationRequest = /^(?:(?:can|could|would) you\s+)?(?:please\s+)?(?:fix|add|implement|change|update|refactor|rename|remove|delete|write|build|test)\b/i.test(text.trim());
  const intent = visualizationRequest && !modificationRequest ? "visualize" : INTENT_PATTERNS.find(([candidate, pattern]) => (!modificationRequest || candidate !== "visualize") && pattern.test(text))?.[0] ?? "general";
  const mode = intent === "inspect" || intent === "general" || intent === "visualize" ? "read" : "modify";
  const verification: ProjectCommand[] =
    intent === "document" || intent === "inspect" || intent === "general" || intent === "visualize"
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
  const availableChecks = CHECK_NAMES
    .filter((name) => model.commands[name])
    .map((name) => `${name}=${model.commands[name]}`);

  return [
    "Casper initial classification (hints, not authority over the request or actual work):",
    `- intent: ${classification.intent}`,
    `- mode: ${classification.mode}`,
    `- available configured checks: ${availableChecks.length ? availableChecks.join("; ") : "none detected"}`,
    "Select checks based on actual work and relevant changed behavior, not request keywords. If casper_check is available, use it for relevant configured checks after edits settle. No mandatory four-check pipeline; docs-only or no-change work may need none. Explain unrun checks without claiming verified behavior.",
    "",
    "User request:",
    request,
  ].join("\n");
}
