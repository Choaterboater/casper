// A line Casper writes for the person (a skill it picked, memory it could not read, a spend note): the transcript's,
// and over `casper acp` the app's too, as a note (decision 88). Progress lines and command output are not these.

import type { CasperApp } from "../app";

/** Writes `line` to the transcript and hands it to the app, if one listens. */
export function personNote(app: Pick<CasperApp, "output" | "onPersonNote">, line: string): void {
  app.output.write(`${line}\n`);
  app.onPersonNote?.(line);
}
