/**
 * "Trust this folder?": asked once per folder at the start of a session, as Claude Code, Codex and Gemini CLI do. In a
 * folder you haven't trusted, Casper's checks, pages and smoke checks don't run, and the AI asks before the project's
 * scripts, builds, tests and installs where no sandbox holds them (src/sandbox/routine.ts). Your home folder and the
 * top of a drive are never trusted and never asked about. A run that can't ask (-p, --json, CI) is trusted, as
 * Claude Code's -p is: starting it there is your choice. The answer is kept per project (src/project/trust.ts).
 */

import os from "node:os";
import type { CasperApp } from "../app";
import type { ProjectContext } from "../project/context";
import { folderTrustDefaults, saveFolderTrust, untrustedReason, type FolderTrust } from "../project/trust";
import { tildePath } from "../new/scaffold";
import { terminalText } from "../tui/format";
import { CHECK_NAMES } from "../verify/evidence";

export const NOT_NOW = "Not now";
export const TRUST_IT = "Trust this folder";

/** What the folder would run if trusted, in the words of the box: its checks, and the services and smoke checks its
 * .casper/project.yaml declares. At most 6, so the box stays short. */
export function wouldRun(context: Pick<ProjectContext, "model" | "services" | "smoke">): string[] {
  const commands = CHECK_NAMES.map((name) => context.model.commands[name]).filter((command): command is string => Boolean(command));
  const named = Object.values(context.model.namedChecks ?? {}).filter((spec) => spec.kind !== "lab" && spec.run).map((spec) => spec.run!);
  const services = Object.keys(context.services ?? {}).map((name) => `the ${name} service`);
  const smoke = context.smoke?.length ? ["smoke checks"] : [];
  return [...new Set([...commands, ...named, ...services, ...smoke])].map((item) => terminalText(item)).slice(0, 6);
}

/** The line that says a folder isn't trusted and what that means, after Not now and in /trust off. */
export const NOT_TRUSTED_LINE = "[trust] Not trusted: you can read and edit here, but Casper's checks don't run, and the AI asks before this "
  + "folder's scripts, builds, tests and installs. Say \"trust this folder\" to change that.\n";

/** The session's trust for the folder just opened: a run that can't ask is trusted; home and drives never are; a saved
 * answer counts (folders Casper kept state for before it asked were saved as trusted, once); otherwise the box. */
export async function decideFolderTrust(app: CasperApp, context: ProjectContext): Promise<void> {
  if (!app.interactive) { app.folderTrust = { trusted: true, from: context.info.root }; return; }
  const home = app.sessionHomeDir ?? os.homedir();
  const found = await folderTrustDefaults.lookup(context.info, home).catch((): FolderTrust => ({ trusted: false, why: "new" }));
  app.folderTrust = found;
  if (found.trusted || found.why !== "new" || app.closing) return;
  // A screen that can't show the box: not trusted, and said so.
  if (!app.terminal.canAsk) { app.output.write(NOT_TRUSTED_LINE); return; }
  const name = terminalText(tildePath(context.info.root, home));
  const runs = wouldRun(context);
  const question = `Trust ${name}?${runs.length ? ` It would run: ${runs.join(", ")}.` : ""}`;
  const answer = await app.terminal.pick(question, [
    { label: NOT_NOW, description: "Read and edit only: no checks, and the AI asks before the project's scripts, builds and installs" },
    { label: TRUST_IT, description: "Saved: Casper runs its checks, and the project's scripts, builds and tests run without a box" },
  ]);
  if (app.closing) return;
  if (answer === TRUST_IT) {
    await saveFolderTrust(context.info.root, home, true).catch(() => {});
    app.folderTrust = { trusted: true, from: context.info.root };
    app.output.write(`[trust] Trusted ${name}. "stop trusting this folder" takes it back.\n`);
    return;
  }
  app.output.write(NOT_TRUSTED_LINE);
}

/** The folder's own skills follow its trust (src/skills/registry.ts setFolderTrusted). */
function followTrust(app: CasperApp): void {
  app.skillRegistry?.setFolderTrusted(app.folderTrust?.trusted === true);
}

/** /trust and /trust off, and the plain words for them ("trust this folder", "stop trusting this folder"). */
export async function trustCommand(app: CasperApp, argument: string): Promise<void> {
  const context = app.projectContext;
  if (!context) { app.output.write("[trust] No folder is open yet.\n"); return; }
  if (argument && argument !== "off") throw new Error("Usage: /trust [off]");
  const home = app.sessionHomeDir ?? os.homedir();
  const root = context.info.root;
  const name = terminalText(tildePath(root, home));
  if (argument === "off") {
    await saveFolderTrust(root, home, false);
    const still = await folderTrustDefaults.lookup(context.info, home).catch((): FolderTrust => ({ trusted: false, why: "new" }));
    app.folderTrust = { trusted: false, why: still.trusted ? "new" : still.why };
    followTrust(app);
    app.output.write(NOT_TRUSTED_LINE);
    if (still.trusted && still.from !== root) {
      app.output.write(`[trust] Not trusted for this session. ${terminalText(tildePath(still.from, home))} is trusted and covers this folder; `
        + "open it and say \"stop trusting this folder\" to take that back.\n");
    }
    return;
  }
  if (app.folderTrust?.trusted === false && app.folderTrust.why !== "new") {
    app.output.write(`[trust] ${untrustedReason(app.folderTrust.why)}.\n`);
    return;
  }
  await saveFolderTrust(root, home, true);
  app.folderTrust = { trusted: true, from: root };
  followTrust(app);
  app.output.write(`[trust] Trusted ${name}: Casper runs its checks after each change, and the project's scripts, builds and tests run as `
    + "routine. \"stop trusting this folder\" takes it back.\n");
}
