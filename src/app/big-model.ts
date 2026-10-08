/** The model when it fails or repairs run out: picking a first model or opening sign-in, one retry after an empty
 * answer, and the user's big model for one more repair (asked first; only a person says yes). Moved from src/app.ts. */

import type { CasperApp } from "../app";
import { formatCost, formatTokens, terminalText } from "../tui/format";
import type { RuntimeSession, RuntimeImage, RuntimeModelInfo, RuntimeStatus } from "../runtime/types";
import type { TaskResult } from "../task/result";
import type { VerificationResult } from "../verify/evidence";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { modelFailedChoices, pictureChoices, REMEMBER_BIG_MODEL_CHOICES, REPAIR_LIMIT_STOP } from "./safe-choices";
import { runLogin } from "./commands";
import { updateFooter } from "./footer";

const LOGIN_PROVIDERS = ["openai-codex", "github-copilot", "anthropic", "openrouter"] as const;

/** A model for one repair: the selector Casper switches with, and the name it shows. */
export interface BigModelChoice {
  query: string;
  label: string;
  /** Picked for this one repair and not saved: Casper never calls it "your big model". */
  oneOff?: true;
}

/** Before a request runs: with no model, pick one for a signed-in provider, or open sign-in (then pick);
 * with the model's credentials missing, open sign-in for that provider. Never a fake "model failed"
 * receipt: when no model can run, the terminal says why and nothing starts; scripts get an error. */
export async function ensureModel(app: CasperApp, session: RuntimeSession): Promise<boolean> {
  const status = session.getStatus?.();
  if (!status?.blocked) return true;
  const signal = app.commandAbort?.signal;
  const canSignIn = app.interactive && app.terminal.rich;
  const pickDefault = async (): Promise<boolean> => {
    const picked = await session.selectDefaultModel?.({ provider: app.loginProvider, signal }).catch(() => undefined);
    if (!picked?.selected) return false;
    app.output.write(`[model] Casper picked ${picked.status.provider}/${picked.status.model} for your signed-in provider and saved it as your default. Use /model to choose another.\n`);
    updateFooter(app);
    return true;
  };
  if (!status.provider) {
    if (await pickDefault()) return true;
    if (canSignIn && !signal?.aborted) {
      app.output.write("[model] No model yet. Sign in to a provider to start; Esc cancels.\n");
      if (await runLogin(app, undefined, true) && await pickDefault()) return true;
    }
  } else if (status.auth === "missing" && canSignIn && !signal?.aborted) {
    const provider = LOGIN_PROVIDERS.find((id) => id === status.provider);
    if (provider) {
      app.output.write(`[model] Credentials missing for ${provider}. Sign in to continue; Esc cancels.\n`);
      if (await runLogin(app, provider, true) && !session.getStatus?.().blocked) return true;
    }
  }
  const after = session.getStatus?.();
  if (!after?.blocked) return true;
  // Where sign-in can't open (a plain terminal or a script), "type a request" would loop: say the step that works.
  const blocked = canSignIn || after.provider ? after.blocked
    : app.signedIn === false ? "Not signed in yet. Run casper in a terminal and type /login."
    : app.interactive ? "No Casper model selected. Type /model to choose one."
    : "No Casper model selected. Pass --model <provider/model>, or run casper and type /model.";
  if (!app.interactive) throw new Error(blocked);
  app.output.write(`[model] ${blocked}\n`);
  return false;
}

/** A provider hiccup Pi does not retry (an empty response) ends a run for no reason of the task's: try once
 * more on its own, then, in the terminal, ask. Sign-in, quota and context errors, and errors Pi already
 * retried within its budget, are not retried again. */
export async function retryModelFailure(app: CasperApp, session: RuntimeSession, request: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const error = app.events.lastError ?? "";
    if (!app.taskRuntimeFailed || app.taskRuntimeCancelled || app.closing || app.commandAbort?.signal.aborted || app.taskTurnLimit !== undefined || app.taskSpendStop !== undefined) return;
    // Only a provider that answered with nothing; Pi already retried what it counts as transient,
    // within the user's retry budget, so never go past that.
    if (!/empty (?:response|completion|message|content)|no (?:content|response|output) (?:was )?returned|returned no (?:content|output)/i.test(error)) return;
    if (isRetryableAssistantError({ stopReason: "error", errorMessage: error } as Parameters<typeof isRetryableAssistantError>[0])) return;
    let retry = attempt === 1;
    let big: { label: string } | undefined;
    if (!retry && app.interactive && app.terminal.rich && attempt <= 4) {
      app.events.ensureLineBreak();
      const bigModel = bigModelOf(app, session);
      // Stop comes first, so Enter never spends more tokens.
      const answer = await app.terminal.ask("The model failed again. What now?",
        modelFailedChoices(bigModel ? terminalText(bigModel.label) : undefined), false, app.commandAbort?.signal);
      if (bigModel && answer?.[0] === "Retry with your big model") big = bigModel;
      retry = answer?.[0] === "Retry" || Boolean(big);
    }
    if (!retry) return;
    app.events.ensureLineBreak();
    const back = big ? await switchToBigModel(app, session, { query: "@reason", label: big.label }) : undefined;
    app.output.write(`[model] ${attempt === 1 ? "The model failed; trying once more." : back ? `Trying again on your big model ${terminalText(big!.label)}.`
      : big ? `Casper could not switch to your big model ${terminalText(big.label)}; trying again on the current model.` : "Trying again."}\n`);
    app.taskRuntimeFailed = false;
    try {
      await session.prompt("Your last response failed with a provider error. Continue the task from where you stopped.",
        app.commandAbort?.signal, { request, maxTurns: app.maxTurns });
    } finally { if (back) await restoreModel(app, session, back); }
  }
}

/** The receipt's big-model part: which model ran repairs, and how many. */
export function bigModelReceipt(app: CasperApp): Pick<TaskResult, "bigModel"> {
  const use = app.bigModelUse;
  return use ? { bigModel: { model: use.model, attempts: use.attempts, ...(use.oneOff ? { oneOff: true as const } : {}) } } : {};
}

/** repair.bigModelLastTry without a big model does nothing; say so once per session. */
export function bigModelNotice(app: CasperApp, session: RuntimeSession): void {
  if (app.bigModelNoticeShown || app.projectContext?.repair.bigModelLastTry !== true) return;
  app.bigModelNoticeShown = true;
  let role: string | undefined;
  try { role = session.getModelRoles?.().reason?.trim(); } catch { role = undefined; }
  if (!role) app.output.write("[model] repair.bigModelLastTry is on but no big model is set. Use /model big <provider/model>.\n");
}

/** The user's big model (the reason role), when one is set, the catalog knows it, and it is not the model in
 * use now. Reading it makes no model call. */
export function bigModelOf(app: CasperApp, session: RuntimeSession): { label: string; info?: RuntimeModelInfo } | undefined {
  let role: string | undefined;
  try { role = session.getModelRoles?.().reason?.trim(); } catch { return undefined; }
  if (!role || !session.selectModel) return undefined;
  let info: RuntimeModelInfo | undefined;
  if (session.describeModel) {
    try { info = session.describeModel("@reason"); } catch { info = undefined; }
    if (!info) return undefined;
  }
  const label = info ? `${info.provider}/${info.id}` : role.replace(/:[a-z]+$/, "");
  const status = session.getStatus?.();
  if (status?.provider && status.model && `${status.provider}/${status.model}` === label) return undefined;
  return { label, ...(info ? { info } : {}) };
}

/** Switch this conversation to the big model for one step; the model to go back to, or undefined when the
 * switch did not happen. Nothing is saved as a default. */
export async function switchToBigModel(app: CasperApp, session: RuntimeSession, big: BigModelChoice): Promise<string | undefined> {
  const status = session.getStatus?.();
  const back = status?.provider && status.model ? `${status.provider}/${status.model}` : undefined;
  if (!back || !session.selectModel) return undefined;
  try {
    const result = await session.selectModel({ query: big.query, persist: false });
    if (!result.selected) return undefined;
  } catch { return undefined; }
  updateFooter(app);
  return back;
}

/**
 * Pictures for the model in use. One that can see them gets them. One that can't: a numbered question when a model
 * you set up can (1 Send without them · 2 Switch to it for this request), else one line and the request goes
 * without them. `switchTo` is the model to switch to for the build turn only (switchForPictures).
 */
export async function imagesForModel(app: CasperApp, session: RuntimeSession, images: RuntimeImage[]): Promise<{ images: RuntimeImage[]; switchTo?: string }> {
  let status: RuntimeStatus | undefined;
  try { status = session.getStatus?.(); } catch { status = undefined; }
  if (status?.images !== false) return { images };
  const name = status.model ? terminalText(status.model) : "This model";
  const them = images.length === 1 ? "it" : "them";
  let vision: RuntimeModelInfo | undefined;
  try { vision = session.visionModel?.(); } catch { vision = undefined; }
  if (!vision) {
    app.output.write(`[image] ${name} can't see pictures, and no model you set up can; the request goes without ${them}. /model picks one that can.\n`);
    return { images: [] };
  }
  const label = `${vision.provider}/${vision.id}`;
  if (!app.interactive || !app.terminal.canAsk) {
    app.output.write(`[image] ${name} can't see pictures; the request goes without ${them}. ${terminalText(label)} can see them (/model ${terminalText(label)}).\n`);
    return { images: [] };
  }
  app.events.ensureLineBreak();
  const choices = pictureChoices(terminalText(label), images.length);
  const picked = await app.terminal.pick(`${name} can't see pictures, and this request has ${images.length === 1 ? "one" : images.length}.`,
    choices, app.commandAbort?.signal);
  if (picked !== choices[1].label) return { images: [] };
  return { images, switchTo: label };
}

/** The switch picked in imagesForModel, right before the build turn; `back` is the model to return to after it. */
export async function switchForPictures(app: CasperApp, session: RuntimeSession, label: string): Promise<string | undefined> {
  const back = await switchToBigModel(app, session, { query: label, label, oneOff: true });
  if (!back) {
    app.output.write(`[model] Casper could not switch to ${terminalText(label)}; the request goes without the pictures.\n`);
    return undefined;
  }
  app.output.write(`[model] On ${terminalText(label)} for this request.\n`);
  updateFooter(app);
  return back;
}

/** Close a /model picker still open from during the task; it holds the model switch, so nothing can switch back
 * until it is gone. Closing it picks nothing, so a model the person chose in it stays theirs. */
export async function closeModelPicker(app: CasperApp): Promise<void> {
  await app.openModelPicker?.close();
}

/** Back to the model the user was on, with its own effort. */
export async function restoreModel(app: CasperApp, session: RuntimeSession, back: string): Promise<void> {
  await closeModelPicker(app);
  try {
    await session.selectModel!({ query: back, persist: false });
    if (!app.closing) app.output.write(`[model] Back on ${terminalText(back)} for your next request.\n`);
  } catch (error) {
    if (!app.closing) app.output.write(`[model] Casper could not switch back to ${terminalText(back)} (${terminalText(error instanceof Error ? error.message : String(error))}); /model ${terminalText(back)} switches back.\n`);
  }
  updateFooter(app);
}

/** What a big-model try costs, in plain words: "about 48k tokens, at least ≈ $0.72". Only the conversation it
 * reads is counted, so the price is a lower bound; without a price only the tokens are named. */
export function bigModelCost(app: CasperApp, session: RuntimeSession, info?: RuntimeModelInfo): { words: string; fits: boolean } {
  let tokens: number | null | undefined;
  try { tokens = session.getUsage?.().context?.tokens; } catch { tokens = undefined; }
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) return { words: "uses tokens", fits: true };
  const fits = !info?.contextWindow || tokens < info.contextWindow;
  const count = formatTokens(tokens);
  const price = info?.inputCostPerMillion ? tokens * info.inputCostPerMillion / 1e6 : undefined;
  return { fits, words: `about ${count} tokens${price !== undefined ? `, at least ≈ ${formatCost(price)}` : ""}` };
}

/**
 * The repair limit is reached and checks still fail: one numbered question. The free answer comes first, so a
 * stray Enter never spends; Esc is the same as Stop. With no big model set, a rich terminal can pick one and
 * remember it. The extra tries granted (1 or 0).
 */
export async function askBigModelRetry(app: CasperApp, failures: VerificationResult[], signal: AbortSignal): Promise<number> {
  const session = app.session;
  if (!session?.selectModel || app.closing || signal.aborted) return 0;
  const names = [...new Set(failures.map((failure) => failure.name))].join(", ") || "the checks";
  const tried = app.repairsTried;
  const question = `${names} still ${failures.length > 1 ? "fail" : "fails"} after ${tried} ${tried === 1 ? "repair" : "repairs"}. What now?`;
  const stop = { ...REPAIR_LIMIT_STOP };
  const big = bigModelOf(app, session);
  let hasRole = false;
  try { hasRole = Boolean(session.getModelRoles?.().reason?.trim()); } catch { hasRole = false; }
  if (!big && hasRole) return 0; // You are already on your big model.
  const picker = !big ? app.terminal.modelPickerHost() : undefined;
  if (!big && !picker) {
    app.events.ensureLineBreak();
    app.output.write("– /model big <provider/model> sets a big model Casper can offer when repairs run out\n");
    return 0;
  }
  const cost = big ? bigModelCost(app, session, big.info) : undefined;
  if (big && cost && !cost.fits) {
    app.events.ensureLineBreak();
    app.output.write(`– Your big model ${terminalText(big.label)} can't hold this conversation (${cost.words}), so it was not offered\n`);
    return 0;
  }
  const retry = big
    ? { label: "Retry with your big model", description: `${terminalText(big.label)} reads this conversation (${cost!.words}), then tries 1 more fix` }
    : { label: "Retry with a bigger model", description: "pick one (uses tokens); Casper can remember it as your big model" };
  app.events.ensureLineBreak();
  const answer = await app.terminal.pick(question, [stop, retry], signal);
  if (answer !== retry.label || signal.aborted || app.closing) return 0;
  if (big) { app.bigModelGrant = { query: "@reason", label: big.label }; return 1; }
  // No big model yet: the picker selects one for this conversation only, then Casper goes back until the repair.
  const status = session.getStatus?.();
  const back = status?.provider && status.model ? `${status.provider}/${status.model}` : undefined;
  let picked: string | undefined;
  try {
    const result = await session.selectModel({ picker, persist: false, signal });
    if (result.selected && result.status.provider && result.status.model) picked = `${result.status.provider}/${result.status.model}`;
  } catch { picked = undefined; }
  if (back && picked && picked !== back) {
    try { await session.selectModel({ query: back, persist: false }); } catch { /* the repair switch reports it */ }
  }
  updateFooter(app);
  if (!picked || picked === back || signal.aborted) return 0;
  // The same size check as for a saved big model: a model that can't hold the conversation is not tried.
  let pickedInfo: RuntimeModelInfo | undefined;
  try { pickedInfo = session.describeModel?.(picked); } catch { pickedInfo = undefined; }
  const pickedCost = bigModelCost(app, session, pickedInfo);
  if (!pickedCost.fits) {
    app.events.ensureLineBreak();
    app.output.write(`– ${terminalText(picked)} can't hold this conversation (${pickedCost.words}), so Casper stopped here\n`);
    return 0;
  }
  const remember = await app.terminal.pick(`Use ${terminalText(picked)} as your big model from now on?`,
    REMEMBER_BIG_MODEL_CHOICES.map((choice) => ({ ...choice })), signal);
  if (remember === "Yes" && session.setModelRole) {
    try {
      await session.setModelRole("reason", picked);
      app.output.write(`[model] Saved ${terminalText(picked)} as your big model.\n`);
    } catch (error) {
      app.output.write(`[model] Could not save your big model: ${terminalText(error instanceof Error ? error.message : String(error))}\n`);
    }
  }
  app.bigModelGrant = { query: picked, label: picked, ...(remember === "Yes" ? {} : { oneOff: true as const }) };
  return 1;
}
