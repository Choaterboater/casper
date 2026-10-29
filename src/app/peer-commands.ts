/** Commands every peer has under the same name: /copy, /export, /rename and /logout. All local; none calls a model. */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CommandHost } from "./commands";
import type { ConversationItem } from "../runtime/types";
import { copyText } from "../tui/clipboard-files";
import { terminalText } from "../tui/format";
import { requestOf } from "../sessions/resume";
import { scrubPlainSecrets } from "../secrets/files";
import { scrubValue, type ScrubTextResult } from "../secrets/scrub";
import { ownValues } from "../verify/model-output";

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
  // The whole conversation as saved (what a compaction took from the AI's context too), else the turns in context.
  let record: ConversationItem[] | undefined;
  try { record = host.session?.conversationRecord?.(); } catch { record = undefined; }
  const items = record ?? turns.map((turn): ConversationItem => turn.role === "user" ? { kind: "you", text: requestOf(turn.text) } : { kind: "answer", text: turn.text.trim() });
  const messages = items.filter((item) => item.kind !== "compaction").length;
  if (!host.session || !messages) { host.output.write("[export] Nothing to save yet: this conversation has no messages.\n"); return; }
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
  const secrets = exportScrubber(host.homeDir());
  const markdown = jsonl ? "" : secrets.hide(`# ${name ?? "Casper conversation"}\n\n${items.map(markdownItem).join("\n")}`);
  let made = false;
  try {
    if (!argument) await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    // Never over an existing file: "wx" fails when it is there.
    await writeFile(file, markdown, { flag: "wx", mode: 0o600 });
    made = true;
    if (jsonl) {
      host.session.exportJsonl!(file);
      // Each line stays the same JSON with its strings through the same pass, so the file reads as before.
      await writeFile(file, secrets.hideJsonl(await readFile(file, "utf8")), { mode: 0o600 });
    }
  } catch (error) {
    // A .jsonl that failed after its empty file was made: removed, so the same name works next time.
    if (made) await rm(file, { force: true }).catch(() => {});
    const code = (error as NodeJS.ErrnoException).code;
    host.output.write(code === "EEXIST" ? `[export] ${shown} is already there; nothing was changed. Give another name: /export <file>\n`
      : `[export] Not saved: ${code === "ENOENT" ? "that folder doesn't exist" : terminalText(error instanceof Error ? error.message : String(error))}.\n`);
    return;
  }
  const hidden = secrets.hidden ? ` ${secrets.hidden} secret${secrets.hidden === 1 ? " in it is" : "s in it are"} hidden (<secret hidden>).` : "";
  host.output.write(`[export] Saved ${jsonl ? "every message" : `${messages} message${messages === 1 ? "" : "s"}`} to ${shown}.${hidden}\n`);
}

/** A picture's or file's base64 in a .jsonl line: data, never words, so it is left as it is. */
const BLOB = /^[A-Za-z0-9+/=\r\n]{4096,}$/;

/** What /export writes goes through the always-on pass that native bash output and a repair round's evidence get
 * (src/secrets/files.ts): secret-named environment values, Casper's login keys and saved network logins, secret
 * KEY=VALUE lines, address passwords, private keys and secrets named in prose. An export can land in a synced folder. */
function exportScrubber(home: string) {
  const values = ownValues(home);
  let hidden = 0;
  const pass = (text: string): ScrubTextResult => BLOB.test(text) ? { text, hidden: 0, kinds: [] } : scrubPlainSecrets(text, { values });
  return {
    get hidden() { return hidden; },
    hide(text: string): string { const result = pass(text); hidden += result.hidden; return result.text; },
    hideJsonl(text: string): string {
      return text.split("\n").map((line) => {
        if (!line.trim()) return line;
        let parsed: unknown;
        try { parsed = JSON.parse(line); } catch { const result = pass(line); hidden += result.hidden; return result.text; }
        const result = scrubValue(parsed, pass);
        hidden += result.hidden;
        return result.hidden ? JSON.stringify(result.value) : line;
      }).join("\n");
    },
  };
}

/** A fence longer than any run of backticks in `text`, so a prompt's own code blocks stay inside it. */
const fenceFor = (text: string) => "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((run) => run[0].length + 1)));

/** One part of the conversation in the exported Markdown. A prompt Casper sent the AI itself (a repair or review round)
 * is Casper's, never "You", in full but folded; a compaction is marked where it happened, with the summary kept. */
function markdownItem(item: ConversationItem): string {
  if (item.kind === "you") return `## You\n\n${item.text}\n`;
  if (item.kind === "answer") return `## Casper\n\n${item.text}\n`;
  if (item.kind === "compaction") {
    return "---\n\n_Casper compacted the conversation here: the AI went on from the summary below. Everything above is still in this file._\n\n"
      + `<details><summary>Summary the AI kept</summary>\n\n${item.summary}\n\n</details>\n`;
  }
  const fence = fenceFor(item.text);
  return `## Casper (${item.label})\n\n_Casper sent this to the AI; you didn't type it._\n\n`
    + `<details><summary>What Casper sent</summary>\n\n${fence}text\n${item.text}\n${fence}\n\n</details>\n`;
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
