/**
 * A job the AI started in the background (bash `background: true`, or a slow command moved there) ended: the AI gets a
 * note in the conversation, and you get one line where you are, in the accent colour (information, not a failure, even
 * when its exit code is not 0). At the prompt the Next row then offers to carry on; only your key sends it. Nothing asks.
 */
import type { CasperApp } from "../app";
import type { EndedCommand } from "../runtime/background-commands";
import { hideCommandSecrets } from "../secrets/files";
import { formatDuration, redactPreview } from "../tui/format";
import { buildNextRow, type NextItem } from "../tui/next-row";

/** "◐ Background job cmd-1 ended with exit code 0 after 34m: node scripts/run.mjs --force": ◐ is background work. */
export function jobEndedLine(ended: EndedCommand, command: string, now = Date.now()): string {
  const shown = redactPreview(hideCommandSecrets(command).text).replace(/\s+/g, " ").trim().slice(0, 100);
  return `◐ Background job ${ended.id} ${ended.how} after ${formatDuration(Math.max(0, now - ended.startedAt))}: ${shown}`;
}

/** The step the row offers once a job ended: the AI already has its note, so the request just goes on. */
export function carryOnItem(ended: EndedCommand): NextItem {
  return { label: `Carry on now that ${ended.id} ended`, command: `${ended.id} has ended (its note is above). Carry on with the request.`, note: "uses tokens" };
}

export function tellJobEnded(app: CasperApp, ended: EndedCommand, command: string): void {
  if (app.closing) return;
  app.events.ensureLineBreak();
  app.output.write(`${jobEndedLine(ended, command)}\n`);
  // While a task runs, the AI reads the note now; a stop from /tasks was yours.
  if (app.interactive && !app.commandActive && !ended.byPerson) app.terminal.offerNext(buildNextRow({ more: [carryOnItem(ended)] }));
}
