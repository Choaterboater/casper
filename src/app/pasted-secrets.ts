/** A secret in what the person pasted (src/secrets/pasted.ts): before a request goes to the AI, one numbered box,
 * 1 Remove it (Enter, Esc) · 2 Send anyway. A run that can't ask, and a line typed while a task runs, have it removed
 * and say so in one line. */

import type { CasperApp } from "../app";
import { pastedSecrets, type PastedSecrets } from "../secrets/pasted";
import { oneAtATime } from "./approvals";
import { isScreenTranscript } from "./request-words";
import { PASTED_SECRET_CHOICES, SEND_PASTED_SECRET } from "./safe-choices";

/** A piece of several lines, or one with a screen's prompts and borders: a copied terminal screen. */
function fromScreen(found: PastedSecrets): boolean {
  return found.from.some((piece) => isScreenTranscript(piece) || piece.split(/\r?\n/).filter((line) => line.trim()).length >= 3);
}

function removedLine(found: PastedSecrets): string {
  const what = found.hidden === 1 ? "a secret" : `${found.hidden} secrets`;
  return `[paste] Removed ${what} from ${fromScreen(found) ? "the copied screen" : "what you pasted"}; the AI gets <secret hidden> in its place.\n`;
}

/** The line and its pastes as they go to the AI: removed unless the person picks Send anyway. */
export async function checkPastedSecrets(app: CasperApp, line: string, pasted: readonly string[]): Promise<{ line: string; pasted: readonly string[] }> {
  const found = pastedSecrets(line, pasted);
  if (!found) return { line, pasted };
  if (app.interactive && app.terminal.canAsk && !app.closing) {
    const question = `This looks like ${fromScreen(found) ? "a copied terminal screen" : "a paste"} with a secret in it:\n`
      + `${found.preview.map((entry) => `  ${entry}`).join("\n")}`;
    const picked = await oneAtATime(app, () => app.terminal.pick(question, [...PASTED_SECRET_CHOICES], app.commandAbort?.signal));
    if (picked === SEND_PASTED_SECRET) return { line, pasted };
  }
  if (!app.closing) app.output.write(removedLine(found));
  return { line: found.text, pasted: found.pasted };
}

/** A line typed while a task runs goes to the AI at once: its pasted secrets are removed, and it says so. */
export function removePastedSecrets(app: CasperApp, line: string, pasted: string[]): { line: string; pasted: string[] } {
  const found = pastedSecrets(line, pasted);
  if (!found) return { line, pasted };
  app.output.write(removedLine(found));
  return { line: found.text, pasted: found.pasted };
}
