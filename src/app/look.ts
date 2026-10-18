/** /look <command> [page or url]: a page review or polish, run as an ordinary task with the browser tool. Only the
 * chosen command's instructions go into that one request. */

import type { CasperApp } from "../app";
import { browserDefaults } from "../browser/discovery";
import { findLookCommand, findLookPage, formatLookPrompt, LOOK_COMMANDS, LOOK_USAGE, lookList, lookRequest, lookWhere, parseLookArgs } from "../look/commands";
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
  const context = app.projectContext;
  if (context?.browser === false) {
    write("[look] The AI's browser is off (/settings, Browser tool), so /look can't open the page. Nothing was started.\n");
    return undefined;
  }
  app.browserInstalled ??= browserDefaults.installed().catch(() => false);
  if (!await app.browserInstalled) {
    write("[look] /look needs Chrome, Chromium or Edge on this computer, or CASPER_BROWSER_EXECUTABLE set to one. Nothing was started.\n");
    return undefined;
  }
  const page = await findLookPage(app.activeWorkspaceRoot(), {
    frameworks: context?.model.frameworks ?? [], packageManager: context?.model.packageManager ?? null, services: context?.services ?? {},
  }, chosen.target);
  if ("reason" in page) { write(`${terminalText(page.reason)}\n`); return undefined; }
  write(`[look] ${chosen.command.name}: ${terminalText(lookWhere(page))}${chosen.command.fixes ? "" : " (a report; no files change)"}\n`);
  return runModelTask(app, lookRequest(chosen.command, page), { guide: formatLookPrompt(chosen.command, page) });
}
