/**
 * Commands the person runs themselves, as in Claude Code and Copilot CLI: a line that starts with `!`, or plain words
 * ("let me run sudo apt update", "I'll run make deploy"). They run at once, with no approval box (you typed them), in
 * Casper's terminal: the screen pauses, the command has the keyboard and the screen, and Casper comes back when it
 * exits. The AI reads its exit code and a short scrubbed tail with the next request. Only the person's own typing
 * counts: a `!` or "let me run" that came from a paste is an ordinary request.
 */

import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CasperApp } from "../app";
import { withoutProviderKeys } from "../platform/environment";
import { hideCommandSecrets } from "../secrets/files";
import { scrubToolOutput } from "../secrets/tool-output";
import { splitShell } from "../sandbox/remote";
import { runAttached } from "../terminal/hand-over";
import { oneAtATime } from "./approvals";
import { networkLoginFile } from "./network-host";
import { ensureRuntime } from "./runtime-start";
import { shownCommand } from "./sandbox";
import { pastedMask } from "./request-words";

const PHRASE = /^(\s*(?:ok(?:ay)?,?\s+)?(?:let me run|i'?ll run|i will run)\s+)(\S[^\n]*?)\s*$/i;

/** The first word names a program: one on the PATH, or a path to a file (./deploy.sh). "let me run the tests" doesn't. */
function namesProgram(command: string, cwd: string): boolean {
  const first = splitShell(command).segments[0]?.words[0];
  if (!first) return false;
  if (/[\\/]/.test(first)) return existsSync(path.resolve(cwd, first.replace(/^~(?=\/)/, os.homedir())));
  return Bun.which(first) !== null;
}

/** The command the person asked to run themselves, or undefined. `pasted` is what was pasted into the line. */
export function typedRunRequest(line: string, pasted: readonly string[], cwd: string): string | undefined {
  if (/[\r\n]/.test(line.trim())) return undefined;
  const mask = pastedMask(line, pasted);
  const lead = line.length - line.trimStart().length;
  if (line[lead] === "!") return mask[lead] ? undefined : line.slice(lead + 1).trim() || undefined;
  const words = PHRASE.exec(line);
  if (!words || mask.slice(0, words[1]!.length).some(Boolean)) return undefined;
  const command = words[2]!.replace(/^`([^`]+)`$/, "$1").trim();
  return namesProgram(command, cwd) ? command : undefined;
}

/** Runs it in Casper's terminal and tells the AI how it ended (for its next turn). */
export async function runTypedCommand(app: CasperApp, command: string): Promise<void> {
  const shown = shownCommand(command).replace(/\s*\n\s*/g, " ");
  if (!app.interactive || app.closing || !app.terminal.rich) {
    app.output.write("[run] Not run: this terminal can't be handed to a command (Casper needs its full screen for that).\n");
    return;
  }
  const cwd = app.activeWorkspaceRoot();
  const env = withoutProviderKeys(process.env, app.shell?.keepEnv ?? []);
  const ran = await oneAtATime(app, async () => {
    if (!app.terminal.canHandOver) return undefined;
    app.output.write(`[run] ${shown} has the terminal now; Casper comes back when it exits.\n`);
    return app.terminal.handOver(() => runAttached(command, cwd, env, { home: app.homeDir(), ...(app.commandAbort ? { signal: app.commandAbort.signal } : {}) }));
  });
  if (!ran) { app.output.write("[run] Not run: Casper's screen is holding another question. Answer it, then type the command again.\n"); return; }
  app.output.write(`[run] ${shown} exited with code ${ran.exitCode}. The AI reads how it ended with your next request.\n`);
  const tail = ran.tail === undefined ? "Its output went to their screen and was not kept." : ran.tail ? `Its last lines:\n${ran.tail}` : "It printed nothing.";
  const note = `The person ran this command themselves in Casper's terminal: ${hideCommandSecrets(command).text}\nIt exited with code ${ran.exitCode}. ${tail}`;
  const scrubbed = await scrubToolOutput(app.scrubber, "bash", { command }, [note], undefined, { configs: app.scrubFiles, networkLoginFile: networkLoginFile(app) });
  try {
    const session = await ensureRuntime(app);
    await session.appendContext?.(`${scrubbed?.texts[0] ?? note}${scrubbed?.note ? `\n${scrubbed.note}` : ""}`);
  } catch (error) {
    app.output.write(`[run] The AI was not told: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
