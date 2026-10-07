/** The person's words for one task ("think hard:", "big model:", "plan first:", ultrathink; see request-words.ts):
 * applied before the task, each said in one line, and undone when it ends, with one line each. */

import type { CasperApp } from "../app";
import type { RuntimeSession } from "../runtime/types";
import { nearestEffort } from "../runtime/auto-effort";
import { terminalText } from "../tui/format";
import type { RequestWords } from "./request-words";
import { closeModelPicker, restoreModel, switchToBigModel } from "./big-model";
import { updateFooter } from "./footer";

const ROLE_NAMES = { reason: "big model", fast: "fast model" } as const;

/** Any word that changes how this task runs. */
export function hasWords(words: RequestWords | undefined): words is RequestWords {
  return Boolean(words && (words.effort || words.role || words.planFirst));
}

function currentModel(session: RuntimeSession): string | undefined {
  try {
    const status = session.getStatus?.();
    return status?.provider && status.model ? `${status.provider}/${status.model}` : undefined;
  } catch { return undefined; }
}

const message = (error: unknown) => terminalText(error instanceof Error ? error.message : String(error));

/** Apply the words to this task; the result puts everything back (and says so). Nothing is saved. */
export async function applyWords(app: CasperApp, session: RuntimeSession, words: RequestWords): Promise<() => Promise<void>> {
  const undo: Array<() => Promise<void>> = [];
  if (words.role) {
    const name = ROLE_NAMES[words.role];
    const current = currentModel(session);
    let selector: string | undefined;
    try { selector = session.getModelRoles?.()[words.role]?.trim(); } catch { selector = undefined; }
    if (!selector || !session.selectModel) {
      app.output.write(`[model] No ${name} is set up; /model role ${words.role} <provider/id> sets one. This task runs on ${terminalText(current ?? "your model")}.\n`);
    } else {
      let label = selector.replace(/:[a-z]+$/, "");
      try { const info = session.describeModel?.(`@${words.role}`); if (info) label = `${info.provider}/${info.id}`; } catch { /* the role's own words */ }
      if (label === current) app.output.write(`[model] ${name} for this task: ${terminalText(label)} (you asked; already on it)\n`);
      else {
        const back = await switchToBigModel(app, session, { query: `@${words.role}`, label });
        if (!back) app.output.write(`[model] Casper could not switch to your ${name} ${terminalText(label)}; this task runs on ${terminalText(current ?? "your model")}.\n`);
        else {
          app.output.write(`[model] ${name} for this task: ${terminalText(label)} (you asked)\n`);
          // A model you picked with /model during the task stays: only the word's own switch is put back.
          undo.unshift(async () => { await closeModelPicker(app); if (currentModel(session) === label) await restoreModel(app, session, back); });
        }
      }
    }
  }
  if (words.effort) {
    let status: ReturnType<NonNullable<RuntimeSession["getStatus"]>> | undefined;
    try { status = session.getStatus?.(); } catch { status = undefined; }
    const levels = (status?.availableThinkingLevels ?? []).filter((level) => level !== "off");
    const target = levels.length ? nearestEffort(words.effort === "top" ? "max" : "low", levels) : undefined;
    const previous = status?.configuredEffort ?? status?.thinkingLevel;
    if (!target || !session.setEffort) {
      app.output.write(`[effort] ${terminalText(status?.model ?? "This model")} has no effort levels; this task runs as normal.\n`);
    } else if (previous === target) app.output.write(`[effort] ${target} for this task (you asked; already on it)\n`);
    else {
      try {
        await session.setEffort(target, false);
        app.output.write(`[effort] ${target} for this task (you asked)\n`);
        if (previous) undo.unshift(async () => {
          try {
            await session.setEffort!(previous, false);
            if (!app.closing) app.output.write(`[effort] Back to ${terminalText(previous)} for your next request.\n`);
          } catch (error) {
            if (!app.closing) app.output.write(`[effort] Casper could not set effort back to ${terminalText(previous)} (${message(error)}); /effort ${terminalText(previous)} does.\n`);
          }
        });
      } catch (error) {
        app.output.write(`[effort] Casper could not set ${target} (${message(error)}); this task runs as normal.\n`);
      }
    }
  }
  if (words.planFirst) app.output.write("[plan] Plan first for this task (you asked).\n");
  updateFooter(app);
  return async () => {
    for (const step of undo) await step();
    updateFooter(app);
  };
}
