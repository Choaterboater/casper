/** /look <command> [page or url]: a page review or polish, run as an ordinary task with the browser tool. Only the
 * chosen command's instructions go into that one request. */

import type { CasperApp } from "../app";
import { browserDefaults } from "../browser/discovery";
import { findLookCommand, findLookPage, formatLookPrompt, LOOK_COMMANDS, LOOK_USAGE, lookList, lookRequest, lookWhere, parseLookArgs, type LookCommand, type LookWords } from "../look/commands";
import { terminalText } from "../tui/format";
import type { VerificationReport } from "../verify/evidence";
import { runModelTask } from "./task-run";

export async function lookCommand(app: CasperApp, args: string): Promise<VerificationReport | undefined> {
  const write = (text: string) => app.output.write(text);
  const parsed = parseLookArgs(args);
  if ("problem" in parsed) { write(`${terminalText(parsed.problem)}\n`); return undefined; }
  let chosen = "list" in parsed ? undefined : parsed;
  if (!chosen) {
    // No command: the list, as a numbered question where Casper can ask, else as lines to read.
    if (!app.interactive || !app.terminal.canAsk) { write(`${lookList()}\n${LOOK_USAGE}\n`); return undefined; }
    const answer = await app.terminal.pick("Look at a page in the browser: which one?",
      LOOK_COMMANDS.map(({ name, description }) => ({ label: name, description })), app.commandAbort?.signal);
    const command = answer ? findLookCommand(answer) : undefined;
    if (!command) return undefined;
    chosen = { command };
  }
  return (await runLook(app, { commands: [chosen.command], ...(chosen.target ? { target: chosen.target } : {}) }))?.report;
}

/** A /look command typed in a session without its slash ("look adapt", src/look/commands.ts lookWords): run as /look,
 * said in one line first. Undefined when /look can't run here: the line then goes to the AI as the person's words, as
 * any other line does. */
export async function lookTyped(app: CasperApp, read: LookWords): Promise<{ report?: VerificationReport } | undefined> {
  if ("list" in read) return { report: await lookCommand(app, "") };
  const names = read.commands.map(({ name }) => `/look ${name}`).join(" and ");
  app.output.write(`[look] Read as ${names}${read.words ? `, with your words: ${terminalText(read.words)}` : ""}\n`);
  return runLook(app, read, true);
}

/** One /look run: one command, or several typed together, on the page given, else the page the last /look looked at in
 * this conversation, else the one Casper finds. Undefined when it can't run; `typed`: the line goes to the AI instead. */
async function runLook(app: CasperApp, chosen: { commands: readonly LookCommand[]; target?: string; words?: string }, typed = false): Promise<{ report?: VerificationReport } | undefined> {
  const write = (text: string) => app.output.write(text);
  const instead = typed ? " The AI gets your words as they are." : " Nothing was started.";
  const context = app.projectContext;
  if (context?.browser === false) {
    write(`[look] The AI's browser is off (/settings, Browser tool), so /look can't open the page.${instead}\n`);
    return undefined;
  }
  app.browserInstalled ??= browserDefaults.installed().catch(() => false);
  if (!await app.browserInstalled) {
    write(`[look] /look needs Chrome, Chromium or Edge on this computer, or CASPER_BROWSER_EXECUTABLE set to one.${instead}\n`);
    return undefined;
  }
  // A follow-up ("look adapt" after "/look critique http://127.0.0.1:8000/") stays on the page already looked at.
  const remembered = chosen.target ? undefined : app.lookPage;
  const page = remembered ?? await findLookPage(app.activeWorkspaceRoot(), {
    frameworks: context?.model.frameworks ?? [], packageManager: context?.model.packageManager ?? null, services: context?.services ?? {},
  }, chosen.target);
  if ("reason" in page) {
    write(typed ? "[look] No page to look at here, so the AI gets your words as they are.\n" : `${terminalText(page.reason)}\n`);
    return undefined;
  }
  app.lookPage = page;
  const fixes = chosen.commands.some((command) => command.fixes);
  write(`[look] ${chosen.commands.map(({ name }) => name).join(" and ")}: ${terminalText(lookWhere(page))}${remembered ? " (the page your last /look looked at)" : ""}${fixes ? "" : " (a report; no files change)"}\n`);
  return { report: await runModelTask(app, lookRequest(chosen.commands, page, chosen.words), { guide: formatLookPrompt(chosen.commands, page) }) };
}
