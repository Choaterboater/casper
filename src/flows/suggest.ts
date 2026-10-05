/**
 * Suggestions: zero-token local rules that read what a task did and offer at most three next steps.
 *
 * After the receipt they are items on the receipt's non-blocking row, numbered after the row's own items
 * (1 Undo · 2 Show diff, then 3, 4, 5). There is never a blocking question after the receipt: typed text
 * is simply the next request. Before work, the plan-first suggestion is one numbered choice inside the
 * checklist panel, so there is still at most one panel before the model starts.
 *
 * Nothing here calls a model. A suggestion that costs tokens says so before it is chosen.
 */
import type { ProjectCommand, ProjectModel } from "../project/model";
import { namedCheckLine, projectCommandLine, PROJECT_YAML } from "../project/config-write";
import type { TaskClassification } from "../task/classify";
import { underSpecifiedTarget } from "../task/classify";
import type { TaskResult } from "../task/result";
import type { FlowCost, FlowRule } from "./catalog";
import { rememberableTestCommand } from "./runners";
import type { SuggestionState } from "./state";
import { lineText } from "../tui/format";

export const MAX_SUGGESTIONS = 3;

/** What choosing a suggestion does. The host carries it out; a rule never runs anything itself. */
export type NextAction =
  /** Send the chosen flow's prompt to the model (uses tokens). */
  | { kind: "flow"; flow: FlowRule }
  /** Save a check command in .casper/project.yaml, exactly as `line` shows it (free). */
  | { kind: "remember-command"; name: ProjectCommand; command: string; line: string }
  /** Save a ready-made check Casper found (verify.checks.<name>) in .casper/project.yaml, exactly as `line` shows it (free). */
  | { kind: "save-check"; name: string; line: string }
  /** A local step another part of Casper registered (a page check, a lab check...). */
  | { kind: "run"; run: () => Promise<string | void> };

export interface NextChoice {
  /** The rule's id: what /suggestions lists and fading counts. */
  id: string;
  label: string;
  /** Why it is offered, in a few plain words. */
  why: string;
  cost: FlowCost;
  action: NextAction;
}

export interface AfterReceiptContext {
  request: string;
  task: TaskResult;
  classification: TaskClassification;
  project: ProjectModel;
  /** Suggestions show only in an interactive rich terminal: never in one-shot runs or --json. */
  interactive: boolean;
}

export interface SuggestionRule {
  id: string;
  /** Lower comes first when more than three fire. */
  priority: number;
  evaluate(context: AfterReceiptContext): NextChoice | undefined;
}

/** "Add a test that proves this bug stays fixed": a fix whose checks pass, but no test shows it works. */
export const proveFixRule: SuggestionRule = {
  id: "prove-fix",
  priority: 10,
  evaluate({ task, classification }) {
    if (task.execution !== "completed" || classification.intent !== "fix") return undefined;
    if (task.verification?.status !== "pass") return undefined;
    const unproven = task.proof?.status === "unproven";
    const skipped = !task.proof && task.proofSkipped !== undefined;
    if (!unproven && !skipped) return undefined;
    return {
      id: "prove-fix",
      label: "Add a test that proves this bug stays fixed",
      why: unproven ? "the tests pass without your fix too" : "no test shows the fix works",
      cost: "tokens",
      action: { kind: "flow", flow: "prove-fix" },
    };
  },
};

/** "Remember <cmd> as this project's test command": the model ran a known test runner without error
 * and the project has no test command. Only known runner shapes are offered, shown exactly as saved. */
export const rememberTestRule: SuggestionRule = {
  id: "remember-test",
  priority: 20,
  evaluate({ task, project }) {
    if (task.execution !== "completed" || project.commands.test) return undefined;
    const observed = [...(task.observedChecks ?? [])].reverse()
      .find((check) => check.name === "test" && check.toolStatus === "success" && rememberableTestCommand(check.command));
    // Or the shell run the task saw while no test command was set (only known runner shapes are recorded).
    const ran = observed?.command ?? task.testRunner;
    const command = ran ? rememberableTestCommand(ran) : undefined;
    if (!command) return undefined;
    const line = projectCommandLine("test", command);
    return {
      id: "remember-test",
      label: `Remember ${command} as this project's test command`,
      why: `the model ran it without error; saves ${line} in ${PROJECT_YAML} so Casper can check every change`,
      cost: "free",
      action: { kind: "remember-command", name: "test", command, line },
    };
  },
};

/** "Save aruba-syntax so Casper checks your playbooks after each change": the task changed YAML in a project where
 * Casper found Ansible playbooks, and the project has not saved that ready-made check. Only the user's pick saves it. */
export const saveFoundCheckRule: SuggestionRule = {
  id: "save-network-check",
  priority: 30,
  evaluate({ task, project }) {
    const found = Object.entries(project.foundChecks ?? {});
    if (task.execution !== "completed" || !found.length) return undefined;
    const changed = (task.changedPaths ?? []).map((file) => file.replace(/\\/g, "/"));
    if (!changed.some((file) => /\.ya?ml$/i.test(file))) return undefined;
    const [name, spec] = found.find(([, entry]) => entry.playbooks?.some((playbook) => changed.includes(playbook))) ?? found[0]!;
    const line = namedCheckLine(name, spec);
    const what = spec.preset === "ansible-render" ? "renders your Junos playbooks" : "checks your playbooks with ansible-playbook --syntax-check";
    return {
      id: "save-network-check",
      label: `Save ${name}: it ${what} after each change`,
      why: `Casper found Ansible playbooks here; saves ${line} in ${PROJECT_YAML}`,
      cost: "free",
      action: { kind: "save-check", name, line },
    };
  },
};

export const BUILT_IN_RULES: readonly SuggestionRule[] = [proveFixRule, rememberTestRule, saveFoundCheckRule];

/** The rules Casper runs after a receipt. Other parts of Casper register theirs (page checks, lab checks). */
export class SuggestionRules {
  private readonly rules = new Map<string, SuggestionRule>();

  constructor(rules: readonly SuggestionRule[] = BUILT_IN_RULES) {
    for (const rule of rules) this.register(rule);
  }

  register(rule: SuggestionRule): void {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(rule.id)) throw new Error(`invalid suggestion id ${JSON.stringify(rule.id)}`);
    if (this.rules.has(rule.id)) throw new Error(`suggestion ${rule.id} is already registered`);
    this.rules.set(rule.id, rule);
  }

  ids(): string[] {
    return [...this.rules.keys()];
  }

  /** At most three suggestions that fired and are not off or faded. A rule that throws is skipped. */
  afterReceipt(context: AfterReceiptContext, state?: Pick<SuggestionState, "visible">): NextChoice[] {
    if (!context.interactive) return [];
    const fired: Array<{ choice: NextChoice; priority: number }> = [];
    for (const rule of [...this.rules.values()].sort((left, right) => left.priority - right.priority)) {
      if (state && !state.visible(rule.id)) continue;
      let choice: NextChoice | undefined;
      try { choice = rule.evaluate(context); } catch { continue; }
      if (choice) fired.push({ choice: { ...choice, id: rule.id }, priority: rule.priority });
    }
    return fired.slice(0, MAX_SUGGESTIONS).map(({ choice }) => choice);
  }
}

export interface SuggestionRow {
  /** Lines to print under the receipt; empty when nothing fired. */
  lines: string[];
  /** Which number picks which suggestion. */
  keys: Array<{ key: number; choice: NextChoice }>;
  /** Whether the key hint was printed (the state counts it). */
  hint: boolean;
}

const COST_WORDS: Record<FlowCost, string> = { tokens: "uses tokens", free: "free" };
const safe = (text: string) => lineText(text).replace(/\s+/g, " ").trim();

/**
 * The suggestions as lines on the receipt's row, numbered after the row's own items (Undo, Show diff).
 * Numbers past 9 are not offered: a single key picks a choice.
 */
export function formatSuggestionRow(choices: readonly NextChoice[], options: { start?: number; hint?: boolean } = {}): SuggestionRow {
  const start = options.start ?? 1;
  const keys = choices.slice(0, MAX_SUGGESTIONS)
    .map((choice, index) => ({ key: start + index, choice }))
    .filter(({ key }) => key <= 9);
  if (!keys.length) return { lines: [], keys: [], hint: false };
  const hint = Boolean(options.hint);
  return {
    lines: [
      "Suggested next:",
      ...keys.map(({ key, choice }) => `  ${key} ${safe(choice.label)} — ${safe(choice.why)} (${COST_WORDS[choice.cost]})`),
      ...(hint ? ["  A number picks one · type to ask something else · /suggestions off stops these"] : []),
    ],
    keys,
    hint,
  };
}

const LIST_LINE = /^\s*(?:[-*•]|\d+[.)])\s+\S/;

/** Separate asks in a request: sentences, list lines, and clauses joined by "and then", "also"... */
export function countAsks(request: string): number {
  const listLines = request.split(/\r?\n/).filter((line) => LIST_LINE.test(line)).length;
  const prose = request.split(/\r?\n/).filter((line) => !LIST_LINE.test(line)).join(" ");
  const clauses = prose
    .split(/(?<=[.!?])\s+(?=[A-Z])|;\s*|,?\s+(?:and then|then|and also|also|plus)\s+|,\s+and\s+(?=(?:add|make|build|create|write|fix|change|update|remove|show|let|support|move|rename|put)\b)/i)
    .map((part) => part.trim())
    .filter((part) => part.split(/\s+/).length >= 2);
  return listLines + clauses.length;
}

export interface BeforeWorkSuggestion {
  id: "plan-first";
  /** Why, for the panel's question: "this asks for 4 things". */
  reason: string;
}

/** A code span, quote, number, path, file name or example: something a build can be checked against. */
const CONCRETE = /`[^`\n]+`|"[^"\n]+"|\d|[\w-]+\/[\w.-]*|\w\.[A-Za-z][A-Za-z0-9]{1,7}\b|\b(?:for example|e\.g\.|such as)\b/i;

/** Whether the request already lists its requirements: two or more list lines, most of them concrete
 * (six words or more, or a detail like a command, number or file). Then the list is the plan. */
export function specificRequest(request: string): boolean {
  const lines = request.split(/\r?\n/).filter((line) => LIST_LINE.test(line)).map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ""));
  if (lines.length < 2) return false;
  const concrete = lines.filter((line) => line.split(/\s+/).length >= 6 || CONCRETE.test(line));
  return concrete.length * 2 > lines.length;
}

/** Plan first: a build or setup request that asks for several things or is long, in an interactive
 * terminal, that does not already talk about a plan. A request that already lists concrete requirements
 * is built as asked. Conservative on purpose; fading absorbs misses. */
export function suggestBeforeWork(request: string, classification: TaskClassification, options: { interactive: boolean }): BeforeWorkSuggestion | undefined {
  if (!options.interactive) return undefined;
  if (classification.intent !== "implement" && classification.intent !== "configure") return undefined;
  if (/\bplan(?:s|ning|ned)?\b/i.test(request)) return undefined;
  if (specificRequest(request)) return undefined;
  const asks = countAsks(request);
  const wordCount = request.trim().split(/\s+/).filter(Boolean).length;
  if (asks >= 3) return { id: "plan-first", reason: `this asks for ${asks} things` };
  if (wordCount >= 60) return { id: "plan-first", reason: "this is a long request" };
  if (asks >= 2 && underSpecifiedTarget(request)) return { id: "plan-first", reason: "this asks for 2 things and names no file" };
  return undefined;
}

export type BeforeWorkChoice = "plan-first" | "build" | "edit";

export interface BeforeWorkPanel {
  question: string;
  options: Array<{ label: string; description: string; choice: BeforeWorkChoice }>;
}

/**
 * The checklist panel with plan-first folded in as its first numbered choice: one panel before work.
 * 1 Plan first · 2 Just build (with the listed cases) · 3 Edit the cases first (only with cases).
 */
export function beforeWorkPanel(suggestion: BeforeWorkSuggestion, cases: readonly string[] = []): BeforeWorkPanel {
  const shown = cases.slice(0, 3).map(safe).join("; ");
  const more = cases.length > 3 ? `; and ${cases.length - 3} more` : "";
  return {
    question: `Suggested: plan first — ${suggestion.reason}`,
    options: [
      { label: "Plan first", choice: "plan-first",
        description: "the model reads and writes a plan and the cases to test; Casper blocks file changes it can see until you choose Build (uses tokens)" },
      { label: "Just build", choice: "build",
        description: !cases.length ? "start now" : cases.length === 1 ? `with this case: ${shown}` : `with these ${cases.length} cases: ${shown}${more}` },
      ...(cases.length ? [{ label: "Edit the cases first", choice: "edit" as const, description: "change, add or delete cases, then build" }] : []),
    ],
  };
}

export type BeforeWorkAnswer =
  | { kind: BeforeWorkChoice }
  /** Esc: build as listed; the suggestion counts as ignored. */
  | { kind: "skipped" }
  /** Free text typed into the panel: the host treats it as one more case to handle. */
  | { kind: "typed"; text: string };

/** The panel's answer (terminal.ask's result) as a choice. */
export function readBeforeWorkAnswer(panel: BeforeWorkPanel, answer: readonly string[] | undefined): BeforeWorkAnswer {
  const first = answer?.[0];
  if (first === undefined) return { kind: "skipped" };
  const option = panel.options.find((item) => item.label === first);
  if (option) return { kind: option.choice };
  const text = safe(first);
  // A plain yes or no answers the question ("Suggested: plan first"); it is not one more case to test.
  const word = text.toLowerCase().replace(/[.!]+$/, "");
  if (/^(?:y|yes|yeah|ok|okay|sure|plan|plan it)$/.test(word)) return { kind: "plan-first" };
  if (/^(?:n|no|nope|no thanks|not now|skip|build|just build it)$/.test(word)) return { kind: "build" };
  return text ? { kind: "typed", text } : { kind: "skipped" };
}
