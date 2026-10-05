/** What a task spends: the quiet note at spend.noteAt and the pause at spend.pauseAt (src/task/spend.ts holds the
 * limits). Moved from src/app.ts. */

import type { CasperApp } from "../app";
import { spendChoices } from "./safe-choices";
import { formatCost, formatLimit, formatTokens, SPEND_STOP_REASON } from "../task/spend";

/** Whether the task's cost is money you pay: not for a free model, and not on a subscription (ChatGPT, Claude),
 * where the catalog price is only what the tokens would cost pay-per-token ("sub ≈$X" in the footer). */
export function spendCharged(app: CasperApp): boolean {
  const status = app.session?.getStatus?.();
  return status?.priced !== false && status?.billing !== "subscription";
}

/** The task's cost after each model response: a quiet note once it reaches spend.noteAt (about $1). */
export function spendNote(app: CasperApp): void {
  const guard = app.spendGuard;
  if (!guard || app.closing || !spendCharged(app)) return;
  const spent = app.observations.spent();
  if (!guard.noteDue(spent.cost)) return;
  // After the model's words from this response, not above them.
  app.terminal.endAssistant();
  app.events.ensureLineBreak();
  app.output.write(`… This task has used ${formatCost(spent.cost)} so far (${formatTokens(spent.tokens)}).\n`);
}

/** Before each tool call: at spend.pauseAt (about $5) the task pauses on a numbered question, Stop here first.
 * A run that can't ask stops there. Either stop keeps the work and says so on the receipt. */
export function spendGate(app: CasperApp, signal?: AbortSignal): Promise<string | undefined> {
  if (app.spendAsk) return app.spendAsk;
  const guard = app.spendGuard;
  if (!guard || app.taskSpendStop) return Promise.resolve(app.taskSpendStop ? SPEND_STOP_REASON : undefined);
  if (!spendCharged(app)) return Promise.resolve(undefined);
  const spent = app.observations.spent();
  const limit = guard.pauseDue(spent.cost);
  if (limit === undefined) return Promise.resolve(undefined);
  const ask = async (): Promise<string | undefined> => {
    const used = `This task has used ${formatCost(spent.cost)}.`;
    if (app.interactive && app.terminal.canAsk && !app.closing) {
      const next = guard.nextAfter(spent.cost)!;
      const answer = await app.terminal.pick(used, spendChoices(formatLimit(next)), signal ?? app.commandAbort?.signal);
      if (answer === "Keep going") { guard.keepGoing(spent.cost); return undefined; }
    } else {
      app.events.ensureLineBreak();
      app.output.write(`[spend] ${used} Casper stops here, at the ${formatLimit(limit)} limit for one task; the work so far is kept. /settings changes the limit.\n`);
    }
    app.taskSpendStop = { spent: spent.cost, limit };
    return SPEND_STOP_REASON;
  };
  app.spendAsk = ask().finally(() => { app.spendAsk = undefined; });
  return app.spendAsk;
}
