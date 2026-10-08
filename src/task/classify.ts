import type { ProjectCommand, ProjectModel } from "../project/model";
import { CHECK_NAMES } from "../verify/evidence";
import { autoDetectedChecks } from "../verify/migrations-check";
import type { VerificationMode } from "../verify/mode";
import { OPEN_ITEM_FORMAT } from "./review";

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

/** The intent a request's opening verb states, and the object it acts on (up to the first clause
 * break): "Add a tool; invalid input is a tool error" is a feature, not a fix. Used only where the
 * keyword order would read an incidental "error" or "test" as the kind of work. */
function leadingIntent(text: string): { intent: TaskIntent; object: string } | undefined {
  const verb = /^(?:(?:can|could|would) you\s+)?(?:please\s+)?(add|implement|build|create|extend|write|fix|refactor|rename)\b\s*(.*)$/is.exec(text);
  if (!verb) return undefined;
  const [, word, rest] = verb;
  const lower = word.toLowerCase();
  // "Build is broken", "Build fails on CI": the noun, not the verb.
  if (lower === "build" && /^(?:is|was|fails|failed|failing|breaks|broke|errors|keeps)\b/i.test(rest)) return undefined;
  const object = rest.split(/[.;:\n](?:\s|$)|\n/, 1)[0]!;
  if (lower === "fix") return { intent: "fix", object };
  if (lower === "refactor" || lower === "rename") return { intent: "refactor", object };
  // Tests as what is made: "tests for X", "a new test file", "tests/foo.test.ts"; a "spec" only as the noun.
  const tests = /\btests?\b|\.(?:test|spec)\.|^(?:[\w`'-]+\s+){0,5}specs?(?:\s+(?:for|of|to|that|covering|in|on)\b|\s*$)/i.test(object);
  return { intent: tests ? "test" : "implement", object };
}

export function classifyTask(text: string): TaskClassification {
  const trimmed = text.trim();
  // Explicit visualization actions take priority over the subject being described.
  const visualizationRequest = /^(?:(?:can|could|would) you\s+)?(?:please\s+)?(?:visuali[sz]e|map out|draw|chart|diagram|mind ?map|flowchart)\b|^(?:(?:can|could|would) you\s+)?(?:please\s+)?(?:show|give|create|make|generate|produce)\b.{0,100}\b(?:diagram|mind ?map|flowchart|dependency graph|chart)\b|\bas (?:a |an )?(?:diagram|mind ?map|flowchart|dependency graph)\b/i.test(trimmed);
  const modificationRequest = /^(?:(?:can|could|would) you\s+)?(?:please\s+)?(?:fix|add|implement|change|update|refactor|rename|remove|delete|write|build|test)\b/i.test(trimmed);
  const keyword = INTENT_PATTERNS.find(([candidate, pattern]) => (!modificationRequest || candidate !== "visualize") && pattern.test(text))?.[0];
  const leading = leadingIntent(trimmed);
  // An incidental "error" or "test" is not the kind of work, but documentation or configuration as the
  // verb's object still is: "Extend the docs with an error table" documents (its first few words only,
  // so "add retry ... without adding a dependency" stays a feature).
  const head = leading?.object.split(/\s+/).slice(0, 5).join(" ") ?? "";
  const objectIntent = INTENT_PATTERNS.find(([candidate, pattern]) => (candidate === "document" || candidate === "configure") && pattern.test(head))?.[0];
  const intent = visualizationRequest && !modificationRequest ? "visualize"
    // An opening build verb decides over a keyword found later: "Add a tool that returns the running
    // configuration" builds a tool; only config or docs as the verb's own object keep those intents.
    : leading && (keyword === undefined || ["fix", "test", "configure", "document", "refactor"].includes(keyword))
      // Only a build verb yields to its object: "Refactor the configuration loader" still refactors.
      ? leading.intent === "implement" && objectIntent ? objectIntent : leading.intent
      : keyword ?? "general";
  const mode = intent === "inspect" || intent === "general" || intent === "visualize" ? "read" : "modify";
  const verification: ProjectCommand[] =
    intent === "document" || intent === "inspect" || intent === "general" || intent === "visualize"
      ? []
      : intent === "test"
        ? ["test"]
        : ["typecheck", "lint", "test", "build"];

  return { intent, mode, verification };
}

/** Bounded lexical probe: does the request name an explicit path, file, or quoted/backticked
 * target? Extensions must start with a letter and span 2+ characters, so "e.g." and version
 * numbers never count as targets. A hint signal only — never authority over the request. */
export function underSpecifiedTarget(text: string): boolean {
  return !/`[^`\n]+`|"[^"\n]+"|'[^'\n]+'|[\w-]+\/[\w.-]+|\w\.[A-Za-z][A-Za-z0-9]{1,7}\b/.test(text);
}

export function formatTaskPrompt(
  request: string,
  classification: TaskClassification,
  model: ProjectModel,
  options: {
    verificationMode?: VerificationMode; proveChange?: boolean; reviewFollows?: boolean; afterContext?: boolean;
    /** The request as typed, before Casper added lines to it (a saved picture's path); the target check reads this. */
    typed?: string;
  } = {},
): string {
  const underSpecified = classification.mode === "modify"
    && (classification.intent === "implement" || classification.intent === "configure")
    && underSpecifiedTarget(options.typed ?? request);
  // A change Casper will review and prove gets the request as the user wrote it. The review asks for
  // every requirement and its test afterwards. In one pinned ablation (GLM 5.3 Flash, core-mcp-tool,
  // .scratch/phase-4/ablate) the request alone was as accurate with fewer turns, and the hint header's
  // "(X, not Y):" framing had been echoed back as invented tool summaries. If the work stops before the
  // review (checks still failing, a turn limit), no later round asks for tests either; that is accepted.
  if (options.proveChange && options.reviewFollows) {
    if (!underSpecified && !options.afterContext) return request;
    return [...(underSpecified ? ["The target is under-specified: if the ask tool is available, ask one concrete question with options before the first edit."] : []),
      "User request:", request].join("\n");
  }
  const availableChecks = [...CHECK_NAMES
    .filter((name) => model.commands[name])
    .map((name) => `${name}=${model.commands[name]}`),
  // Named checks the model may run through casper_check; lab checks are left out (only the user starts them).
  ...Object.entries(model.namedChecks ?? {}).filter(([, spec]) => spec.kind !== "lab")
    .map(([name, spec]) => `${name}=${spec.run ?? `${spec.preset} (Casper runs it)`}${spec.kind === "report" ? " (a report, not a pass/fail check)" : ""}`),
  // Checks Casper found in the project (SQL migrations, Playwright tests).
  ...autoDetectedChecks(model).map(({ name, command }) => `${name}=${command}`)];

  return [
    "Casper initial classification (hints, not authority over the request or actual work):",
    `- intent: ${classification.intent}`,
    `- mode: ${classification.mode}`,
    ...(underSpecified ? ["- target: under-specified; if the ask tool is available, ask one concrete question with options before the first edit"] : []),
    `- available configured checks: ${availableChecks.length ? availableChecks.join("; ") : "none detected"}`,
    // Which checks to pick and when is in casper_check's description; this is what it does not say.
    "If you ran tests yourself, say in one line what ran and the result. Don't claim a check passed that didn't run.",
    // Auto mode only: Casper owns the final run, so the model need not select checks to record them.
    ...(options.verificationMode === "auto" ? ["Casper runs the final checks itself after your last edit and records them; you do not need to. Use casper_check while iterating if it helps. Bash runs of checks are diagnostics only."] : []),
    // Proving: Casper reruns the test check on the code without the change; only a test of the new behavior fails there.
    ...(options.proveChange ? ["If you change code, Casper then checks that the tests fail without your change and pass with it. Add or update a test that exercises the requested behavior so it would fail without your change.", "Before finishing, review every requirement in the request and project docs. Count a requirement as done only when a test you can name asserts it; otherwise add the test or leave it open. A rule that covers several inputs, options or errors is several requirements. Do not list the covered ones: end with only the requirements still not done, one line each; with none left, no list:", OPEN_ITEM_FORMAT] : []),
    "",
    "User request:",
    request,
  ].join("\n");
}
