/**
 * casper_secret: the AI asks the person for a password, token or key, and never sees it. Casper shows its own hidden box
 * (the one the ssh password uses: nothing typed is echoed), then puts the value where the AI said: a file in the project,
 * mode 600 and never one git tracks (a file git would pick up is added to .gitignore, and the person and the AI are told),
 * or `$NAME` for the AI's next command only. The AI gets back where it went and its length, never the value; the value
 * joins the session's typed secrets, so it is hidden in every output, record and export from then on. A run that can't
 * show the hidden box refuses; nothing is ever asked in chat. Decision: docs/adr/0002/44-the-secret-box.md.
 */

import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RuntimeTool, RuntimeToolResult } from "../runtime/types";
import { classifyPath, displayPath, resolveToolPath, type PathContext } from "../platform/project-paths";
import { isOutside } from "../platform/inside";
import { terminalText } from "../tui/format";
import { setForNextCommand } from "./next-command";
import { rememberTypedSecret } from "./typed";

export const SECRET_TOOL = "casper_secret";

const DESCRIPTION = "Ask the user for a password, token or key in Casper's hidden box; never ask in chat or build a form. "
  + "You get where it went and its length, never the value. saveTo: a project file (mode 600, never a tracked file; a .env "
  + "file gets NAME=value). No saveTo: $NAME is set for your next command only.";

export interface SecretAsk {
  name: string;
  /** The AI's reason, as it gave it (untrusted: shown as plain text). */
  why: string;
  /** Where the value goes, in the person's words: "the file .env" or "the AI's next command, as $NAME". */
  to: string;
}

export interface SecretToolHost {
  /** The project folder, and the person's home (for showing paths). */
  root(): string;
  home(): string;
  /** The private places the AI's file tools refuse (sandbox.denyRead and the like). */
  privatePaths?(): readonly string[];
  /** Casper's hidden box can be shown now: an interactive session with its full terminal. */
  canAsk(): boolean;
  /** Plan mode: nothing in the project changes. */
  planning?(): boolean;
  /** The hidden box. The value, or undefined when the person skipped it (Esc, Ctrl+C, nothing typed). */
  ask(ask: SecretAsk, signal?: AbortSignal): Promise<string | undefined>;
  /** A line for the person (never the AI). */
  tell(text: string): void;
  /** git, by argv, in the project: its exit code. */
  git(root: string, args: string[]): Promise<{ code: number | null }>;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** Names the next command must keep as they are: the shell's own, the loader's, git's, ssh's and Casper's. */
const RESERVED = /^(?:PATH|HOME|SHELL|USER|LOGNAME|IFS|ENV|BASH_ENV|PS\d|PROMPT_COMMAND|NODE_OPTIONS|TMPDIR|LD_\w*|DYLD_\w*|GIT_\w*|SSH_\w*|CASPER_\w*|PI_\w*)$/i;

/** A file that holds NAME=value lines: .env, .env.local, prod.env. */
export function isEnvFile(file: string): boolean {
  return /^\.env(?:\..+)?$|\.env$/i.test(path.basename(file));
}

/** The value as a .env file takes it: bare when plain, quoted otherwise. */
function envValue(value: string): string {
  if (/^[\w@%+=:,./-]*$/.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  return `"${value.replace(/[\\"$`]/g, (char) => `\\${char}`)}"`;
}

/** `text` with NAME set to `value`: its line replaced where it was (other lines for NAME dropped), or added at the end. */
export function withEnvLine(text: string, name: string, value: string): string {
  const line = `${name}=${envValue(value)}`;
  const own = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`);
  const lines = text ? text.replace(/\r?\n$/, "").split(/\r?\n/) : [];
  let placed = false;
  const out: string[] = [];
  for (const entry of lines) {
    if (!own.test(entry)) { out.push(entry); continue; }
    if (!placed) { out.push(line); placed = true; }
  }
  if (!placed) out.push(line);
  return `${out.join("\n")}\n`;
}

function refused(text: string): RuntimeToolResult {
  return { text, isError: true };
}

/** Where a file save may go, or why not. Checked before the box opens, so nobody types a secret that can't be kept. */
async function fileTarget(host: SecretToolHost, given: string): Promise<{ absolute: string; shown: string; relative: string } | { error: string }> {
  const root = host.root(), home = host.home();
  const absolute = resolveToolPath(given, root, home);
  const relative = path.relative(root, absolute);
  const shown = displayPath(absolute, root, home);
  if (!relative || isOutside(relative)) return { error: `Not asked: ${shown} is outside this project. Save it to a file in the project (such as .env).` };
  const context: PathContext = { root, home, ...(host.privatePaths?.().length ? { denyRead: host.privatePaths() } : {}) };
  const kind = classifyPath(absolute, context, true);
  if (kind === "gitInternal" || kind === "protected") return { error: `Not asked: ${shown} belongs to git or holds settings Casper doesn't change.` };
  if (kind === "outside" || kind === "linksOut") return { error: `Not asked: ${shown} leads outside this project. Save it to a plain file in the project.` };
  const stats = await lstat(absolute).catch(() => undefined);
  if (stats && !stats.isFile()) return { error: `Not asked: ${shown} is not a plain file.` };
  const literal = `:(literal)${relative.split(path.sep).join("/")}`;
  if ((await host.git(root, ["ls-files", "--error-unmatch", "--", literal])).code === 0) {
    return { error: `Not asked: git tracks ${shown}, so the secret would be committed. Pick a file git doesn't track, such as .env.` };
  }
  return { absolute, shown, relative: relative.split(path.sep).join("/") };
}

/** Adds the file to .gitignore when git would otherwise pick it up. True when it did. */
async function keepOutOfGit(host: SecretToolHost, relative: string): Promise<boolean> {
  const root = host.root();
  if ((await host.git(root, ["rev-parse", "--is-inside-work-tree"])).code !== 0) return false;
  if ((await host.git(root, ["check-ignore", "-q", "--", relative])).code !== 1) return false;
  const ignore = path.join(root, ".gitignore");
  const before = await readFile(ignore, "utf8").catch(() => "");
  await writeFile(ignore, `${before}${before && !before.endsWith("\n") ? "\n" : ""}/${relative}\n`);
  return true;
}

/** Writes the value, mode 600 before anything is in it. */
async function saveFile(absolute: string, name: string, value: string): Promise<void> {
  await mkdir(path.dirname(absolute), { recursive: true });
  const exists = await lstat(absolute).then(() => true, () => false);
  if (exists) await chmod(absolute, 0o600);
  const text = isEnvFile(absolute) ? withEnvLine(exists ? await readFile(absolute, "utf8") : "", name, value) : value;
  await writeFile(absolute, text, { mode: 0o600 });
  await chmod(absolute, 0o600);
}

export function secretTool(host: SecretToolHost): RuntimeTool {
  return {
    name: SECRET_TOOL,
    description: DESCRIPTION,
    inputSchema: {
      type: "object", additionalProperties: false, required: ["name", "why"],
      properties: {
        name: { type: "string", maxLength: 64, description: "Like TUNNEL_TOKEN" },
        why: { type: "string", maxLength: 200, description: "One line the user reads in the box" },
        saveTo: { type: "string", maxLength: 1024, description: "Project file path" },
      },
    },
    // One hidden box at a time.
    sequential: true,
    async execute(args, signal) {
      const { name, why, saveTo } = args;
      if (typeof name !== "string" || !NAME.test(name)) return refused("Not asked: name must be letters, digits and _ (like TUNNEL_TOKEN).");
      if (typeof why !== "string" || !why.trim()) return refused("Not asked: why must say in one line what it is for.");
      if (saveTo !== undefined && (typeof saveTo !== "string" || !saveTo.trim())) return refused("Not asked: saveTo must be a file path in the project, or left out.");
      if (saveTo === undefined && RESERVED.test(name)) return refused(`Not asked: $${name} is one the shell or Casper uses. Pick another name.`);
      if (saveTo !== undefined && host.planning?.()) return refused("Not asked: plan mode changes no files. Ask for it when you build.");
      const target = saveTo === undefined ? undefined : await fileTarget(host, saveTo);
      if (target && "error" in target) return refused(target.error);
      if (!host.canAsk()) {
        host.tell(`[secret] The AI asked for ${name}, and this run can't show Casper's hidden box, so nothing was asked.\n`);
        return refused(`Not asked: this run can't show Casper's hidden box (it needs Casper's full terminal). Don't ask for ${name} in chat; `
          + `tell the user to put it in ${target ? target.shown : "a file in the project"} themselves.`);
      }
      const to = target ? `the file ${target.shown} (only you can read it; the AI gets only its length)` : `the AI's next command only, as $${name}`;
      const value = await host.ask({ name, why: terminalText(why.trim()).slice(0, 200), to: terminalText(to) }, signal).catch(() => undefined);
      if (!value) return refused(`The user skipped it; nothing was saved. Don't ask for ${name} in chat.`);
      // Hidden everywhere from this moment, before it goes anywhere.
      rememberTypedSecret(value);
      const length = Array.from(value).length;
      if (!target) {
        setForNextCommand(name, value);
        host.tell(`[secret] ${name} is set for the AI's next command only.\n`);
        return { text: `$${name} is set for your next command only (${length} characters). Use "$${name}" in it; its value shows as <secret hidden>.` };
      }
      try {
        await saveFile(target.absolute, name, value);
      } catch (error) {
        return refused(`Not saved: ${terminalText(error instanceof Error ? error.message : String(error)).replace(value, "<secret hidden>").slice(0, 200)}`);
      }
      const ignored = await keepOutOfGit(host, target.relative).catch(() => false);
      host.tell(`[secret] Saved ${name} to ${target.shown} (only you can read it).${ignored ? ` Added ${target.shown} to .gitignore.` : ""}\n`);
      return { text: `Saved ${name} to ${target.shown} (${length} characters, mode 600${isEnvFile(target.absolute) ? `, as ${name}=…` : ""}).`
        + `${ignored ? ` Added ${target.shown} to .gitignore so git won't commit it.` : ""} Read it from the file; don't print it.` };
    },
  };
}
