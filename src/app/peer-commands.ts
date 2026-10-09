/** Commands every peer has under the same name: /copy, /export, /rename and /logout. All local; none calls a model. */

import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CommandHost } from "./commands";
import { copyText } from "../tui/clipboard-files";
import { terminalText } from "../tui/format";
import { requestOf } from "../sessions/resume";

/** Where /export saves when no file is named: ~/.casper/exports. */
export function exportFolder(home: string): string { return path.join(home, ".casper", "exports"); }

/** The fenced code blocks of an answer, in order, without their fences. */
export function codeBlocks(text: string): string[] {
  return [...text.matchAll(/^ {0,3}(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^ {0,3}\1[ \t]*$/gm)].map((match) => match[2]!.replace(/\n$/, ""));
}

/** /copy [n], /export [file] and /rename <title>: the conversation the person sees, to the clipboard, a file or a name. */
export async function conversationCommand(host: CommandHost, prompt: string): Promise<void> {
  const [, command, rest = ""] = /^\/(copy|export|rename)(?:\s+([\s\S]*))?$/.exec(prompt.trim())!;
  const argument = rest.trim();
  if (command === "rename") {
    const title = terminalText(argument).replace(/\s+/g, " ").trim().slice(0, 80);
    if (!title) throw new Error("Usage: /rename <title>");
    const session = await host.ensureRuntime();
    if (!session.setSessionName) throw new Error("This runtime can't name conversations.");
    session.setSessionName(title);
    host.updateFooter();
    host.output.write(`[session] This conversation is now ${JSON.stringify(title)}; /resume lists it by that name.\n`);
    return;
  }
  const turns = host.session?.recentTurns?.(Number.MAX_SAFE_INTEGER) ?? [];
  if (command === "copy") {
    if (argument && !/^[1-9]\d*$/.test(argument)) throw new Error("Usage: /copy [n] (n: a code block of the last answer, 1 is the first)");
    const answer = [...turns].reverse().find((turn) => turn.role === "assistant")?.text;
    if (!answer) { host.output.write("[copy] Nothing to copy yet: no answer in this conversation.\n"); return; }
    const blocks = codeBlocks(answer);
    const n = argument ? Number(argument) : undefined;
    if (n !== undefined && n > blocks.length) {
      host.output.write(`[copy] The last answer has ${blocks.length ? `${blocks.length} code block${blocks.length === 1 ? "" : "s"}` : "no code blocks"}; /copy copies all of it.\n`);
      return;
    }
    const text = n === undefined ? answer : blocks[n - 1]!;
    try { await (host.copyText ?? copyText)(text); }
    catch (error) { host.output.write(`[copy] Couldn't reach the clipboard: ${terminalText(error instanceof Error ? error.message : String(error))}\n`); return; }
    const lines = text.split("\n").length;
    host.output.write(`[copy] Copied ${n === undefined ? "the last answer" : `code block ${n} of the last answer`} (${lines} line${lines === 1 ? "" : "s"}).\n`);
    return;
  }
  if (!host.session || !turns.length) { host.output.write("[export] Nothing to save yet: this conversation has no messages.\n"); return; }
  let id = "";
  let name: string | undefined;
  try { const info = host.session.getSessionInfo?.(); id = info?.sessionId.slice(0, 8) ?? ""; name = info?.name; } catch { /* not saved: no id */ }
  // A named file goes where asked (from the project folder); the default goes in ~/.casper/exports, with Casper's other
  // per-user files, so an export never lands in the repo to be committed by mistake.
  const file = argument ? path.resolve(host.activeWorkspaceRoot(), argument)
    : path.join(exportFolder(host.homeDir()), `casper-conversation${id ? `-${id}` : ""}.md`);
  // The whole path, so it can be opened or copied as shown.
  const shown = terminalText(file);
  const jsonl = /\.jsonl$/i.test(file);
  if (jsonl && !host.session.exportJsonl) throw new Error("This runtime can't save every message; use a .md file.");
  const markdown = `# ${name ?? "Casper conversation"}\n\n${turns.map((turn) => `## ${turn.role === "user" ? "You" : "Casper"}\n\n${turn.role === "user" ? requestOf(turn.text) : turn.text.trim()}\n`).join("\n")}`;
  let made = false;
  try {
    if (!argument) await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    // Never over an existing file: "wx" fails when it is there.
    await writeFile(file, jsonl ? "" : markdown, { flag: "wx", mode: 0o600 });
    made = true;
    if (jsonl) host.session.exportJsonl!(file);
  } catch (error) {
    // A .jsonl that failed after its empty file was made: removed, so the same name works next time.
    if (made) await rm(file, { force: true }).catch(() => {});
    const code = (error as NodeJS.ErrnoException).code;
    host.output.write(code === "EEXIST" ? `[export] ${shown} is already there; nothing was changed. Give another name: /export <file>\n`
      : `[export] Not saved: ${code === "ENOENT" ? "that folder doesn't exist" : terminalText(error instanceof Error ? error.message : String(error))}.\n`);
    return;
  }
  host.output.write(`[export] Saved ${jsonl ? "every message" : `${turns.length} message${turns.length === 1 ? "" : "s"}`} to ${shown}.\n`);
}

const SIGN_IN_KINDS = { api_key: "API key", oauth: "browser sign-in" } as const;

/** /logout [provider]: list the sign-ins /login saved, or remove one. Keys in environment variables stay. */
export async function runLogout(host: CommandHost, provider: string): Promise<void> {
  if (host.subagents.isBusy) throw new Error("Wait for active subagents before signing out.");
  const runtime = await host.acquireRuntime();
  if (!runtime.savedSignIns || !runtime.signOut) { host.output.write("[logout] This runtime keeps no sign-ins.\n"); return; }
  const signal = host.commandAbort?.signal;
  const saved = await runtime.savedSignIns(signal);
  const list = saved.map((entry) => `  ${entry.provider.padEnd(16)} ${SIGN_IN_KINDS[entry.type]}`).join("\n");
  if (!provider) {
    host.output.write(saved.length ? `Sign-ins Casper saved:\n${list}\nType /logout <provider> to remove one. Environment variables are unchanged.\n`
      : "[logout] No sign-in saved by /login. Environment variables (OPENROUTER_API_KEY and the like) are unchanged.\n");
    return;
  }
  if (!await runtime.signOut(provider, signal)) {
    host.output.write(`[logout] No saved sign-in for ${JSON.stringify(terminalText(provider))}.${saved.length ? ` Saved: ${saved.map((entry) => entry.provider).join(", ")}.` : ""}\n`);
    return;
  }
  host.updateFooter();
  host.output.write(`[logout] Removed the saved sign-in for ${provider}. Environment variables are unchanged; /login signs in again.\n`);
}
