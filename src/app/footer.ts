/** The footer and what shows around the work: the status line and window title, the step rail, /details, /pane (the
 * steps split in tmux or iTerm2) and ctrl+t. Moved from src/app.ts. */

import type { CasperApp } from "../app";
import path from "node:path";
import { PANE_MIN_COLUMNS } from "../tui/terminal";
import { readPaneSetting, savePaneSetting, type PaneSetting } from "../tui/pane-setting";
import { sessionTitle, windowTitle } from "../tui/session-title";
import { DISPLAY_LEVELS, nextDisplay, type DisplayLevel } from "../tui/display";
import { formatEffort, noModelFooter, terminalText } from "../tui/format";
import type { RuntimeSession } from "../runtime/types";
import { formatCost, formatFooterSpend, formatTokens } from "../task/spend";
import { phaseEvent, type PhaseEvent } from "./json-events";
import { editUserConfig } from "../config/user-write";

export function updateFooter(app: CasperApp): void {
  if (!app.projectContext) return;
  app.terminal.setTitle(windowTitle(conversationName(app), app.commandActive));
  // "ALLOW ALL" first: no box asks there. Both end with ctrl+o (or /mcp writes off on a plain terminal).
  const all = app.broker?.allowAllServers() ?? [];
  const writes = (app.mcp?.writesOn() ?? []).filter((server) => !all.includes(server));
  const parts = [...(all.length ? [`ALLOW ALL: ${all.join(", ")}`] : []), ...(writes.length ? [`WRITES: ${writes.join(", ")}`] : [])];
  // `/permissions all` is on: the shell stops asking until you quit. Always shown, first, and it says how to end it.
  const asking = app.stopAsking ? ["ASKING OFF · /permissions ask"] : [];
  const mcp = parts.length ? [`${parts.join(" · ")} · ${app.terminal.rich ? "ctrl+o" : "/mcp writes off"}`] : [];
  app.terminal.setBadge([...asking, ...mcp].join(" · ") || undefined);
  try {
    const project = app.projectContext.info;
    const status = app.session?.getStatus?.();
    const usage = app.session?.getUsage?.();
    const percent = usage?.context?.percent;
    const effort = (status && formatEffort(status, true)) ?? "effort —";
    const model = status?.model ? `${status.provider}/${status.model} · ${effort}`
      : app.session ? app.signedIn === false ? noModelFooter(false, app.interactive && app.terminal.rich) : "no model selected · /model"
      : (app.runModel ? `${terminalText(app.runModel)} (--model)` : app.savedModelDisplay) ?? noModelFooter(app.signedIn, app.interactive && app.terminal.rich);
    // The current task's tokens and the session's total, with cost from the provider or the model's price; a free
    // model shows tokens only. A subscription pays no per-token price: its figure is only what the tokens would cost.
    const spent = app.observations.spent();
    const session = { tokens: app.spentBefore.tokens + spent.tokens, cost: app.spentBefore.cost + spent.cost };
    const shown = formatFooterSpend(spent, session, app.commandActive, status?.priced, status?.billing);
    const task = shown ? ` │ ${shown}` : "";
    app.terminal.setStatus(`${project.name}/${project.gitBranch ?? "no git"} │ ${model} │ ctx ${percent == null ? "—" : `${percent.toFixed(0)}%~`}${task}${buildersText(app)}${app.commandActive ? "" : " │ idle"}`, project.root);
  } catch { app.terminal.setStatus("Session status unavailable · /status", app.projectContext.info.root); }
}

/** " │ 1 reviewer · 2 builders · $0.19" while reviewers or builders work (what they spent so far joins the task when
 * each ends). Explorers are not counted. */
export function buildersText(app: Pick<CasperApp, "subagents">): string {
  const runs = app.subagents.runs();
  const reviewers = runs.filter((run) => run.role === "reviewer");
  const builders = runs.filter((run) => run.role === "builder");
  const counted = [...reviewers, ...builders];
  if (!counted.length) return "";
  const tokens = counted.reduce((sum, run) => sum + (run.spent?.tokens ?? 0), 0);
  const cost = counted.reduce((sum, run) => sum + (run.spent?.estimatedCost ?? 0), 0);
  const spent = cost > 0 ? ` · ${formatCost(cost)}` : tokens ? ` · ${formatTokens(tokens)}` : "";
  const who = [...(reviewers.length ? [`${reviewers.length} reviewer${reviewers.length === 1 ? "" : "s"}`] : []),
    ...(builders.length ? [`${builders.length} builder${builders.length === 1 ? "" : "s"}`] : [])].join(" · ");
  return ` │ ${who}${spent}`;
}

export function conversationName(app: CasperApp): string {
  try { return app.session?.getSessionInfo?.().name ?? path.basename(app.projectContext!.info.root); }
  catch { return path.basename(app.projectContext!.info.root); }
}

/** A conversation's first request names it, for the window title and /resume. A resumed one keeps its name. */
export function nameConversation(app: CasperApp, session: RuntimeSession, prompt: string): void {
  try {
    const name = session.getSessionInfo?.().name ? undefined : sessionTitle(prompt);
    if (name) session.setSessionName?.(name);
  } catch { /* a conversation that is not saved has no name; the title shows the folder */ }
}

/** A stage of the work starts or ends: a JSON phase event for scripts, and the footer's step rail. */
export function phase(app: CasperApp, phase: PhaseEvent["phase"], state: PhaseEvent["state"]): void {
  app.onEvent?.(phaseEvent(phase, state));
  app.steps.update(phase, state);
  app.terminal.setSteps(app.steps.text());
}

export function clearSteps(app: CasperApp): void {
  app.steps.clear();
  app.terminal.setSteps(undefined);
}

/** How much of the work shows: /details for this session, else display: in your config, else normal. */
export function displayLevel(app: CasperApp): DisplayLevel { return app.displayChoice ?? app.projectContext?.display ?? "normal"; }

/** The saved /pane setting. Inside tmux the pane is on unless turned off; iTerm2 waits for its one question. */
export async function loadPaneSetting(app: CasperApp): Promise<void> {
  app.paneSetting = await readPaneSetting(app.homeDir());
  const where = app.terminal.paneHost;
  app.terminal.setPane(app.paneSetting ?? (where === "iterm" ? "off" : "on"));
}

/** iTerm2, nothing saved yet: one numbered question before the first task (1 keeps one window). The answer is saved;
 * Esc asks again next session. Splitting iTerm2 goes through its scripting, which macOS may ask you to allow. */
export async function askPaneOnce(app: CasperApp): Promise<void> {
  if (app.paneAsked || app.paneSetting !== undefined || app.terminal.paneHost !== "iterm" || !app.terminal.canAsk || app.closing) return;
  app.paneAsked = true;
  const yes = "Yes, split when the window is wide";
  const picked = await app.terminal.pick("Show Casper's steps in a split beside this window? (iTerm2 may ask once to let Casper control it.)", [
    { label: "No, keep one window", description: "steps show in the Working box; /pane on turns the split on later" },
    { label: yes, description: `${PANE_MIN_COLUMNS}+ columns; /pane off turns it off` },
  ]);
  if (picked === undefined || app.closing) return;
  await savePane(app, picked === yes ? "on" : "off");
}

export async function savePane(app: CasperApp, setting: PaneSetting): Promise<void> {
  app.paneSetting = setting;
  app.terminal.setPane(setting);
  try { await savePaneSetting(app.homeDir(), setting); }
  catch (error) { app.output.write(`[pane] Not saved (${terminalText(error instanceof Error ? error.message : String(error))}); it holds for this session.\n`); }
}

/** /pane, /pane on, /pane off (saved in ~/.casper/pane.json). */
export async function paneCommand(app: CasperApp, argument: string): Promise<void> {
  if (argument && argument !== "on" && argument !== "off") throw new Error("Usage: /pane | /pane on | /pane off");
  const where = app.terminal.paneHost;
  const place = where === "tmux" ? "tmux" : where === "iterm" ? "iTerm2" : undefined;
  if (!argument) {
    const on = (app.paneSetting ?? (where === "iterm" ? undefined : "on")) === "on";
    app.output.write(place
      ? `[pane] ${on ? "On" : "Off"}: ${on ? `Casper's steps show in a ${place} split beside this window when it is ${PANE_MIN_COLUMNS}+ columns wide` : "steps show in the Working box"}. /pane ${on ? "off" : "on"} switches it (saved).\n`
      : `[pane] The steps split works inside tmux or iTerm2 on a Mac; here steps show in the Working box. Saved setting: ${app.paneSetting ?? "on"}.\n`);
    return;
  }
  await savePane(app, argument as PaneSetting);
  app.output.write(argument === "on"
    ? `[pane] On: Casper's steps show in a split beside this window when it is ${PANE_MIN_COLUMNS}+ columns wide${place ? "" : " (inside tmux or iTerm2)"}; saved.\n`
    : "[pane] Off: steps show in the Working box; saved. /pane on turns the split back on.\n");
}

/** /details [quiet|normal|detailed] [--session]: no word goes to the next level. Remembered like /effort (display:
 * in ~/.casper/config.yaml, written for you); --session keeps it to this session. */
export async function detailsCommand(app: CasperApp, argument: string): Promise<void> {
  const session = /(?:^|\s)--session$/.test(argument);
  const level = argument.replace(/(?:^|\s)--session$/, "").trim();
  if (level && !DISPLAY_LEVELS.some(known => known === level)) throw new Error("Usage: /details [quiet|normal|detailed] [--session]");
  app.displayChoice = (level as DisplayLevel) || nextDisplay(displayLevel(app));
  const words: Record<DisplayLevel, string> = {
    quiet: "the model's words, failures and receipts",
    normal: "steps fold into one summary line, with the changed files under it",
    detailed: "every step, with a small diff under each edit",
  };
  let saved = false;
  if (!session) {
    try { await editUserConfig(app.homeDir(), ["display"], app.displayChoice); saved = true; }
    catch (error) { app.output.write(`[details] Not saved (${terminalText(error instanceof Error ? error.message : String(error))}); for this session only.\n`); }
  }
  app.output.write(`[details] ${app.displayChoice}: ${words[app.displayChoice]}. ${saved ? "Saved; /details <level> --session changes only this session." : "For this session only."}\n`);
}

export function expandLastStep(app: CasperApp): void {
  const step = app.events.lastStep();
  if (!step) { app.terminal.flashNote("no step to show yet"); return; }
  app.terminal.endAssistant();
  app.terminal.writePanel(step.title, step.body, { diff: step.diff });
}
