/**
 * The app's side of suggestions: which ones go on the row under a receipt (from slot 3; 1 and 2 stay for Undo and
 * Show diff), what a later key or line means for fading, and /suggestions. Zero tokens: rules read the finished
 * task locally, and a suggestion that would spend tokens says so on the row before anyone picks it.
 */
import type { ProjectContext } from "../project/context";
import type { TaskClassification } from "../task/classify";
import type { TaskResult } from "../task/result";
import { FIRST_EXTRA_SLOT, type NextItem } from "../tui/next-row";
import { SuggestionRules, type NextChoice } from "../flows/suggest";
import { SuggestionState, FADE_AFTER_IGNORES, FADE_DAYS } from "../flows/state";

/** What the row's hint says, the first few times suggestions show in a project. */
export const SUGGESTION_HINT = "A number picks one · type to ask something else · /suggestions off stops these";
/** The command a suggestion's key submits. */
export const SUGGESTION_COMMAND = "/suggestion";
/** Suggestions that are not after-receipt rules but can still be turned off and fade: the plan-first choice. */
const BEFORE_WORK_IDS = ["plan-first"] as const;
const LAST_SLOT = 9;

export interface ChosenSuggestion {
  choice: NextChoice;
  /** The request of the task whose receipt offered it. */
  request: string;
}

export class SuggestionController {
  readonly rules = new SuggestionRules();
  private readonly states = new Map<string, SuggestionState>();
  private offered?: { choices: NextChoice[]; request: string };
  private chosen?: ChosenSuggestion;

  constructor(private readonly write: (text: string) => void, private readonly homeDir: () => string) {}

  /** The state for this project, loaded once; a broken file is started again with one line saying so. */
  async state(context: ProjectContext | undefined): Promise<SuggestionState | undefined> {
    if (!context) return undefined;
    const root = context.info.root;
    let state = this.states.get(root);
    if (!state) {
      try { state = await SuggestionState.load({ root, homeDir: this.homeDir(), configOff: context.suggestions === false }); }
      catch { return undefined; }
      this.states.set(root, state);
      for (const notice of state.notices) this.write(`${notice}\n`);
    }
    // suggestions: false from /settings applies now, not from the next start.
    state.useConfig(context.suggestions === false);
    return state;
  }

  /** Items for the row after this task, numbered after `taken` extra items; remembers what was shown. */
  async items(input: { context: ProjectContext; task: TaskResult; request: string; classification: TaskClassification; interactive: boolean;
    taken: number }): Promise<{ items: NextItem[]; hint?: string }> {
    this.offered = undefined;
    if (!input.interactive) return { items: [] };
    // Most receipts fire no rule: then the saved state is not even read, so the prompt comes back at once.
    const context = { request: input.request, task: input.task, classification: input.classification, project: input.context.model, interactive: true };
    if (!this.rules.afterReceipt(context).length) return { items: [] };
    const state = await this.state(input.context);
    if (!state || state.allOff) return { items: [] };
    const room = LAST_SLOT - (FIRST_EXTRA_SLOT - 1) - input.taken;
    const choices = this.rules.afterReceipt(context, state).slice(0, Math.max(0, room));
    if (!choices.length) return { items: [] };
    const hint = state.hintDue ? SUGGESTION_HINT : undefined;
    this.offered = { choices, request: input.request };
    await state.recordShown(choices.map((choice) => choice.id), Boolean(hint)).catch(() => {});
    return {
      items: choices.map((choice) => ({ label: choice.label, command: `${SUGGESTION_COMMAND} ${choice.id}`,
        note: choice.cost === "tokens" ? "uses tokens" : "free", why: choice.why })),
      ...(hint ? { hint } : {}),
    };
  }

  /** Suggestions are on offer from the last receipt (the next line settles them). */
  get pending(): boolean {
    return this.offered !== undefined;
  }

  /** A line with nothing on offer: no earlier pick carries over to it. */
  forgetChoice(): void {
    this.chosen = undefined;
  }

  /** Called with every line that follows a receipt. Picking one resets its fading; every suggestion shown and not
   * picked counts as ignored once (three in a row hide it here for 14 days). */
  async settle(prompt: string, context: ProjectContext | undefined): Promise<void> {
    const offered = this.offered;
    this.offered = undefined;
    this.chosen = undefined;
    if (!offered) return;
    const id = new RegExp(`^${SUGGESTION_COMMAND}\\s+([a-z0-9-]+)$`).exec(prompt.trim())?.[1];
    const choice = offered.choices.find((item) => item.id === id);
    if (choice) this.chosen = { choice, request: offered.request };
    const state = await this.state(context);
    if (!state) return;
    if (choice) await state.recordChosen(choice.id).catch(() => {});
    const ignored = offered.choices.filter((item) => item !== choice).map((item) => item.id);
    if (ignored.length) await state.recordIgnored(ignored).catch(() => {});
  }

  /** The suggestion the user just picked by `/suggestion <id>`, once. */
  take(id: string): ChosenSuggestion | undefined {
    const chosen = this.chosen;
    this.chosen = undefined;
    return chosen?.choice.id === id ? chosen : undefined;
  }

  /** Every suggestion Casper knows. */
  ids(): string[] {
    return [...BEFORE_WORK_IDS, ...this.rules.ids()];
  }

  /** /suggestions, /suggestions on|off [name]. */
  async command(args: string, context: ProjectContext | undefined): Promise<string> {
    const state = await this.state(context);
    if (!state) return "[suggestions] Suggestions are unavailable here (no project state).\n";
    const [action, name, ...rest] = args.split(/\s+/).filter(Boolean);
    if (action === undefined) {
      const lines = this.ids().map((id) => {
        const status = state.status(id);
        const until = status === "faded" ? state.hiddenUntil(id) : undefined;
        return `  ${id.padEnd(14)} ${status}${until ? ` (hidden here until ${until.toISOString().slice(0, 10)})` : ""}`;
      });
      return `Suggestions (free rules; a suggestion that uses tokens says so before you pick it):\n${lines.join("\n")}\n`
        + `Ignored ${FADE_AFTER_IGNORES} times in a row in a project, a suggestion is hidden there for ${FADE_DAYS} days; picking it resets that.\n`
        + (state.offByConfig ? "suggestions: false in your config.yaml turns them all off.\n" : "/suggestions off [name] and /suggestions on [name] turn them off or on.\n");
    }
    if ((action !== "on" && action !== "off") || rest.length || (name !== undefined && !this.ids().includes(name))) {
      return `Usage: /suggestions [on|off] [${this.ids().join("|")}]\n`;
    }
    if (action === "on" && state.offByConfig) return "[suggestions] suggestions: false in your config.yaml keeps them off; /settings turns them on.\n";
    await state.setOff(action === "off", name);
    return `[suggestions] ${name ?? "All suggestions"} ${action === "off" ? "off" : "on"}${name ? "" : " everywhere"}.\n`;
  }
}
