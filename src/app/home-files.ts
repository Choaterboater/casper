import type { CasperApp } from "../app";
import { giveBack, homeFiles, rootInOthersHome, rootOwnedNote, type Owner } from "../platform/home-owner";
import { terminalText } from "../tui/format";

/** At start. As root in someone else's home (`sudo casper`): what root left there goes back to its owner now, in
 * the background, and again at exit. As you: a plain note naming any of your files root owns, with the command. */
export async function keepHomeFilesYours(app: CasperApp, home: string): Promise<void> {
  const owner = await rootInOthersHome(home).catch(() => undefined);
  if (owner) {
    app.homeOwner = { home, owner };
    app.homeSweep = giveBack(await homeFiles(home), owner).then(() => {}, () => {});
    app.output.write("[home] Running as root: files Casper and Claude Code leave in your home are given back to you.\n");
    return;
  }
  const note = await rootOwnedNote(home).catch(() => undefined);
  if (note) app.output.write(`[home] ${terminalText(note)}\n`);
}

/** At exit, after the runtime has stopped writing. */
export async function returnHomeFiles(app: { homeOwner?: { home: string; owner: Owner }; homeSweep?: Promise<void> }): Promise<void> {
  if (!app.homeOwner) return;
  await app.homeSweep;
  await giveBack(await homeFiles(app.homeOwner.home), app.homeOwner.owner).catch(() => {});
}
