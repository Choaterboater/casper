/** A task that stopped on a used-up Claude plan window goes on by itself once the window resets (src/task/plan-reset.ts,
 * decision 107). It is one of keep going's rounds (decision 39), so keep_going: off turns it off too. */

import type { CasperApp } from "../app";
import type { RuntimeSession } from "../runtime/types";
import { planWindowName } from "../runtime/plan-limits";
import { KEEP_GOING_ROUNDS } from "../task/keep-going";
import { PLAN_RESET_PROMPT, planReset, planTooFarLine, planWaitLine, planWaitWhy, realClock, RESET_GRACE_MS, sameFiles, waitUntil } from "../task/plan-reset";
import { retryModelFailure } from "./big-model";

/** The Claude plan's own provider (src/runtime/claude-subscription.ts): only a task on it waits for its reset. */
const PLAN_PROVIDER = "claude-subscription";

const stopped = (app: CasperApp) => app.closing || app.commandAbort?.signal.aborted === true || app.taskRuntimeCancelled;

/**
 * The task's turn failed on a used-up Claude plan window. "none": it didn't (keep going decides). "stopped": it did,
 * and the task ends there: a reset more than a day away, a model that isn't the plan's (a failover model never gets
 * the resumed turn), no round left, or the wait was cancelled (a typed line, Esc, the folder's files changed). "resumed":
 * Casper waited for the reset and sent the AI on, as round `round` of keep going.
 */
export async function goOnAtPlanReset(app: CasperApp, session: RuntimeSession, request: string, round: number): Promise<"none" | "stopped" | "resumed"> {
  if (!app.taskRuntimeFailed || stopped(app) || app.taskTurnLimit !== undefined || app.taskSpendStop !== undefined) return "none";
  const clock = app.planResetClock ?? realClock;
  const reset = planReset(app.events.lastError ?? "", clock.now());
  if (!reset) return "none";
  if (session.getStatus?.().provider !== PLAN_PROVIDER || round > KEEP_GOING_ROUNDS) return "stopped";
  const say = (line: string) => { app.events.ensureLineBreak(); app.output.write(`${line}\n`); };
  if (!reset.wait) { say(planTooFarLine(reset, clock.now())); return "stopped"; }
  const signal = app.commandAbort?.signal;
  const root = app.activeWorkspaceRoot();
  const why = planWaitWhy(reset, clock.now());
  // From here a line you type cancels it (src/app/during-work.ts), also one typed while the folder is listed below, and
  // a line already waiting runs next instead.
  let typed = app.queuedLines.length > 0;
  let wait: ReturnType<typeof waitUntil> | undefined;
  app.planWait = { why, cancel: () => { typed = true; wait?.cancel(); } };
  const cancelled = () => typed || app.queuedLines.length > 0;
  try {
    // The folder as the stop left it: a change while Casper waits (you, an editor, another tool) means it doesn't go on.
    const before = await app.snapshotWorkspace(root, signal).catch(() => undefined);
    if (stopped(app) || cancelled()) return "stopped";
    say(planWaitLine(reset, app.terminal.rich, clock.now()));
    wait = waitUntil(reset.resetsAt + RESET_GRACE_MS, { ...(signal ? { signal } : {}), clock });
    await app.away?.waitFor(why);
    const reached = await wait.done;
    if (!reached || stopped(app) || cancelled()) {
      if (cancelled() && !stopped(app)) say("Cancelled: Casper doesn't go on by itself.");
      return "stopped";
    }
    if (session.getStatus?.().provider !== PLAN_PROVIDER) { say("The model changed while Casper waited, so it doesn't go on by itself."); return "stopped"; }
    const after = await app.snapshotWorkspace(root, signal).catch(() => undefined);
    if (stopped(app) || cancelled()) return "stopped";
    if (!sameFiles(before, after)) { say("Files in this folder changed while Casper waited, so it doesn't go on by itself."); return "stopped"; }
  } finally {
    app.planWait = undefined;
    // A terminal that closed during the wait (or while the folder was listed) made the job wait too: it works again.
    await app.away?.waitOver();
  }
  say(`↻ keep going ${round}/${KEEP_GOING_ROUNDS}: Claude's ${planWindowName(reset.window)} limit reset, so the AI carries on (Esc stops it)`);
  app.taskRuntimeFailed = false;
  app.lastAnswer = "";
  await session.prompt(PLAN_RESET_PROMPT, signal, { request, maxTurns: app.maxTurns, followUp: true });
  await retryModelFailure(app, session, request);
  return "resumed";
}
