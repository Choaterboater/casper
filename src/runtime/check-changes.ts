import { constants } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { createEditToolDefinition, createWriteToolDefinition, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { realpathLongest } from "../platform/project-paths";
import { isOutside } from "../platform/inside";
import { readOnlyCommand } from "../sandbox/read-only";
import { commandSegments, commandStart, splitShell } from "../sandbox/remote";
import { testDefinition } from "../verify/test-definition";

export const CHECK_CHANGE_QUESTION = "Change the test check for this project?";
export const CHECK_CHANGE_CHOICES = ["No", "Yes, save this change", "Use this command for this session only"] as const;
export interface CheckChange {
  file: string;
  before: string;
  after: string;
  /** Only command changes can be used without saving a script. */
  sessionCommands?: Record<string, string>;
}
export interface CheckChangeOptions {
  commands(): Record<string, string>;
  taskKey?(): unknown;
  ask(change: CheckChange): Promise<"save" | "session" | undefined>;
  /** Apply approved replacements to the current registries, for both saved and session-only changes. */
  useSessionCommands?(commands: Record<string, string>): void;
}

/** Native file operations call this inside Pi's mutation queue, with the actual final text (not a guessed edit).
 * Shell writes naming these files are refused: native edit/write can show the exact old → new before saving. */
export class SessionOnlyCheck extends Error {
  constructor(readonly file: string) { super(`kept ${file} as it is: session-only check in use`); }
}

export class CheckChangeGuard {
  private taskKey: unknown;
  private sessionOnly = false;
  private pending = Promise.resolve();
  /** `home`: where the shell's `~` and $HOME lead (a test seam). */
  constructor(private readonly root: string, private readonly options?: CheckChangeOptions, private readonly home = os.homedir()) {}

  private async configured(text?: string): Promise<Record<string, string>> {
    const source = text ?? await readFile(path.join(this.root, ".casper/project.yaml"), "utf8").catch(() => "");
    const document = parse(source) ?? {};
    const project = document.project ?? document;
    const commands: Record<string, string> = {};
    for (const name of ["test", "lint", "typecheck", "build"]) {
      const command = document.verify?.[name] ?? project.commands?.[name];
      if (typeof command === "string") commands[name] = command;
    }
    for (const [name, spec] of Object.entries(document.verify?.checks ?? {})) {
      if (spec && typeof spec === "object" && "run" in spec && typeof spec.run === "string") commands[name] = spec.run;
    }
    return commands;
  }

  private async files(): Promise<Set<string>> {
    const files = new Set([realpathLongest(path.join(this.root, ".casper/project.yaml"))]);
    const commands = [...Object.values(await this.configured()), ...Object.values(this.options?.commands() ?? {})];
    for (const command of new Set(commands)) {
      for (const label of (await testDefinition(this.root, command, true)).keys()) {
        // Section labels carry a suffix, but a script's own path may contain spaces.
        const file = label.startsWith("package.json ") ? "package.json" : label.replace(/ \[(?:test|tool\.pytest|tool:pytest|pytest)\]$/, "");
        files.add(realpathLongest(path.join(this.root, file)));
      }
    }
    return files;
  }

  write(file: string, after: string, signal?: AbortSignal): Promise<void> {
    const next = this.pending.then(() => this.writeOne(file, after, signal));
    this.pending = next.catch(() => {});
    return next;
  }

  private async writeOne(file: string, after: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const key = this.options?.taskKey?.();
    if (key !== this.taskKey) { this.taskKey = key; this.sessionOnly = false; }
    const identity = realpathLongest(file);
    if (!(await this.files()).has(identity)) { await writeFile(file, after, "utf8"); return; }
    if (this.sessionOnly) throw new SessionOnlyCheck(path.relative(this.root, file).split(path.sep).join("/"));
    const before = await readFile(file, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    if (before === after) return;
    const config = identity === realpathLongest(path.join(this.root, ".casper/project.yaml"));
    let change: CheckChange = { file: path.relative(this.root, file).split(path.sep).join("/"), before, after };
    if (config) {
      let oldCommands: Record<string, string>, newCommands: Record<string, string>;
      try { oldCommands = await this.configured(before); newCommands = await this.configured(after); }
      catch { throw new Error("Not changed: the project check configuration must be valid YAML."); }
      // Non-check settings remain ordinary project edits. Named preset/settings changes still need approval.
      const contract = (text: string) => {
        const doc = parse(text) ?? {};
        return JSON.stringify([(doc.project ?? doc).commands ?? {}, doc.verify ?? {}, doc.verification ?? {}]);
      };
      if (contract(before) === contract(after)) { await writeFile(file, after, "utf8"); return; }
      const keys = new Set([...Object.keys(oldCommands), ...Object.keys(newCommands)]);
      const changed = [...keys].filter((key) => oldCommands[key] !== newCommands[key]);
      const current = this.options?.commands() ?? {};
      if (changed.length && changed.every((key) => key in current && Boolean(newCommands[key]?.trim())) && this.options?.useSessionCommands) {
        change = { ...change, sessionCommands: Object.fromEntries(changed.map((key) => [key, newCommands[key]!])) };
      }
    }
    const answer = await this.options?.ask(change);
    signal?.throwIfAborted();
    if (answer === "session" && change.sessionCommands && this.options?.useSessionCommands) {
      this.options.useSessionCommands(change.sessionCommands);
      this.sessionOnly = true;
      throw new SessionOnlyCheck(change.file);
    }
    if (answer !== "save") throw new Error("Not changed: changing configured checks needs your OK. Use native edit/write to request it; No or no answer keeps the existing check.");
    // A save made while the box was open invalidates this approval; never overwrite unseen text.
    if (await readFile(file, "utf8").catch(() => "") !== before) throw new Error("Not changed: the file changed while approval was open; read it and ask again.");
    await writeFile(file, after, "utf8");
    // Saving also means use it now, not only after a restart. Apply only after the approved write succeeds.
    if (change.sessionCommands) this.options?.useSessionCommands?.(change.sessionCommands);
  }

  async shellReason(command: string): Promise<string | undefined> {
    if (readOnlyCommand(command, { root: this.root })) return undefined;
    // Executing the configured command is not permission to rewrite it.
    if (Object.values(this.options?.commands() ?? await this.configured()).includes(command.trim())) return undefined;
    const { targets, globs, unknown } = shellWritePaths(command, this.root, this.home);
    const checks = [...await this.files()].filter((file) => !isOutside(path.relative(realpathLongest(this.root), file)));
    if (checks.some((file) => targets.some((target) => !isOutside(path.relative(realpathLongest(target), file)))
      || globs.some((glob) => globReaches(glob, file)))) {
      return "Not run: this command may change a configured check. Use native edit/write so Casper can show old → new and ask 'Change the test check for this project?'";
    }
    // Refused only because the destination can't be read: say that, not that it changes a check.
    if (checks.length && unknown.length) {
      return `Not run: Casper can't tell where \`${unknown[0]}\` leads, so this copy could replace a configured check. Write the destination as a plain path. Use native edit/write to change a check.`;
    }
    return undefined;
  }
}

/** Keep literal cd operands scoped to their shell; a copy's destination can replace all its descendants. */
function shellWritePaths(command: string, root: string, home: string): { targets: string[]; globs: string[]; unknown: string[] } {
  const targets: string[] = [];
  const globs: string[] = [];
  /** Copy destinations that could lead anywhere, as written. */
  const unknown: string[] = [];
  const visit = (text: string, folders: string[], depth: number) => {
    if (depth > 4) return;
    let cursor = 0;
    for (const segment of splitShell(text).segments) {
      const end = text.indexOf(segment.text, cursor) + segment.text.length;
      cursor = end;
      const at = commandStart(segment.words);
      const name = path.basename(segment.words[at] ?? "").replace(/\.exe$/i, "");
      const args = segment.words.slice(at + 1);
      if (name === "cd") {
        let operand = 0;
        while (/^-[LP]+$/.test(args[operand] ?? "")) operand++;
        if (args[operand] === "--") operand++;
        if (args.length === operand + 1) {
          const moved = folders.map((folder) => path.resolve(folder, expandHome(args[operand]!, folder, home) ?? args[operand]!));
          folders = text.slice(end).trimStart().startsWith("&&") ? moved : [...folders, ...moved];
        }
        continue;
      }
      const operands = shellWriteTargets(segment.text, segment.words);
      if (name === "cp") {
        const target = args.findIndex((word) => word === "-t" || (word.length > 2 && "--target-directory".startsWith(word)));
        const joined = args.find((word) => /^-[a-zA-Z]*t./.test(word)
          || (word.startsWith("--") && word.includes("=") && "--target-directory".startsWith(word.slice(0, word.indexOf("=")))));
        const destination = target >= 0 ? args[target + 1] : joined
          ? joined.startsWith("--") ? joined.slice(joined.indexOf("=") + 1) : joined.replace(/^-[a-zA-Z]*t(?=.)/, "")
          : args.at(-1);
        if (destination) {
          // Where the shell would put it: a path, a glob or, past a variable it can't know, the folder above or anywhere.
          for (const folder of folders) {
            const where = copyDestination(destination, folder, home);
            targets.push(...where.paths);
            globs.push(...where.globs);
            if (where.anywhere && !unknown.includes(destination)) unknown.push(destination);
          }
        }
      }
      for (const operand of operands) for (const folder of folders) targets.push(path.resolve(folder, expandHome(operand, folder, home) ?? operand));
      if (["sh", "bash", "dash", "zsh", "ksh", "ash", "fish"].includes(name)) {
        const flag = args.findIndex((word) => /^-[a-z]*c[a-z]*$/i.test(word));
        if (flag >= 0 && args[flag + 1]) visit(args[flag + 1]!, folders, depth + 1);
      } else {
        for (const nested of commandSegments(segment.text).slice(1)) visit(nested.text, folders, depth + 1);
      }
    }
  };
  visit(command, [root], 0);
  return { targets, globs, unknown };
}

/** The most brace lists expand to before a destination is taken as unknown. */
const BRACE_LIMIT = 32;
/** Parts of a word the shell replaces with something Casper can't know (a variable, a command) or can't list (a brace
 * list it doesn't split), and the glob characters, which it matches against the configured checks. */
const UNKNOWN = /[$`{}]/;
const GLOB = /[*?[\]]/;

/** A path word with `~`, `~+`, $HOME and $PWD as the shell expands them; undefined for another user's `~name` or `~-`. */
function expandHome(word: string, folder: string, home: string): string | undefined {
  let text = word;
  const tilde = /^~([^/]*)(?=\/|$)/.exec(text);
  if (tilde) {
    if (tilde[1] === "") text = home + text.slice(1);
    else if (tilde[1] === "+") text = folder + text.slice(2);
    else return undefined;
  }
  return text.replace(/\$(?:\{HOME\}|HOME\b)/g, () => home).replace(/\$(?:\{PWD\}|PWD\b)/g, () => folder);
}

/** A cp destination as the shell reads it: `~`, $HOME and the like expanded, and brace lists split. Each result is a
 * path, a glob, or past a part Casper can't know the folder above it; `anywhere` when that part leads the word, the
 * home of another user, or a `..` after it could climb out. */
function copyDestination(word: string, folder: string, home: string): { paths: string[]; globs: string[]; anywhere: boolean } {
  const paths: string[] = [], globs: string[] = [];
  const text = expandHome(word, folder, home);
  if (text === undefined) return { paths, globs, anywhere: true };
  for (const each of braces(text)) {
    const parts = each.split(/[\\/]/);
    const first = parts.findIndex((part) => UNKNOWN.test(part) || GLOB.test(part));
    if (first < 0) { paths.push(path.resolve(folder, each)); continue; }
    const absolute = path.isAbsolute(each);
    // A `..` after an unknown part could climb out of the folder above it; so could an unknown first part.
    if ((first === 0 && !absolute) || parts.slice(first).includes("..")) return { paths, globs, anywhere: true };
    const above = path.resolve(folder, parts.slice(0, first).join("/") || path.sep);
    if (parts.slice(first).some((part) => UNKNOWN.test(part))) paths.push(above);
    else globs.push(path.join(realpathLongest(above), ...parts.slice(first)));
  }
  return { paths, globs, anywhere: false };
}

/** Simple brace lists ({a,b}) split into each word, as the shell does. A nested list, a range or too many words stays
 * as it is, and its braces then mark it unknown. */
function braces(word: string): string[] {
  let words = [word];
  for (;;) {
    const next: string[] = [];
    let split = false;
    for (const each of words) {
      const list = /\{([^{}]*,[^{}]*)\}/.exec(each);
      if (!list) { next.push(each); continue; }
      split = true;
      for (const choice of list[1]!.split(",")) next.push(each.slice(0, list.index) + choice + each.slice(list.index + list[0].length));
    }
    if (!split) return words;
    if (next.length > BRACE_LIMIT) return [word];
    words = next;
  }
}

/** Whether a glob names the file or a folder it is in (a copy into a folder can replace what it holds). Matched with
 * `/` separators: `*` and `?` stay within one name, `[…]` is a set of characters. */
function globReaches(glob: string, file: string): boolean {
  const slash = (text: string) => text.split(path.sep).join("/");
  let source = "";
  const pattern = slash(glob);
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!;
    if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else if (char === "[" && pattern.indexOf("]", index + 2) > 0) {
      const close = pattern.indexOf("]", index + 2);
      const set = pattern.slice(index + 1, close).replace(/^!/, "^").replace(/\\/g, "\\\\");
      source += `[${set}]`;
      index = close;
    } else source += char.replace(/[.+^${}()|\\[\]]/g, "\\$&");
  }
  const match = new RegExp(`^${source}$`);
  for (let at = file, before = ""; at !== before; before = at, at = path.dirname(at)) if (match.test(slash(at))) return true;
  return false;
}

/** Only write operands, never a reader's input or a copy's source. Output operators inside quotes are data. */
function shellWriteTargets(text: string, words: string[]): string[] {
  const targets: string[] = [];
  let quote: string | undefined;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === "\\" && quote !== "'") { index++; continue; }
    if (quote) { if (char === quote) quote = undefined; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char !== ">") continue;
    while (text[index + 1] === ">" || text[index + 1] === "|") index++;
    const both = text[index + 1] === "&";
    if (both) index++;
    const target = splitShell(text.slice(index + 1).trimStart()).segments[0]?.words[0];
    // Bash also accepts >&filename; only a number or '-' means descriptor duplication/closure.
    if (target && !(both && /^(?:\d+|-)$/.test(target))) targets.push(target);
  }
  const at = commandStart(words);
  const name = path.basename(words[at] ?? "").replace(/\.exe$/i, "");
  const args = words.slice(at + 1);
  if (/^(?:python[23]?|node|bun|perl|ruby|php)$/.test(name)) {
    const option = args.findIndex((word) => ["-c", "-e", "-r"].includes(word));
    const code = option < 0 ? undefined : args[option + 1];
    if (code) {
      // Literal API operands only: a read or printed string containing "write" is not a write.
      for (const match of code.matchAll(/\bopen\s*\(\s*(["'])(.*?)\1\s*,\s*(?:mode\s*=\s*)?(["'])([^"']*)\3/g)) {
        if (/[wax+]/.test(match[4]!)) targets.push(match[2]!);
      }
      for (const match of code.matchAll(/\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|unlink(?:Sync)?|remove|rename|truncate|rmtree|File\.(?:write|binwrite)|file_put_contents)\s*\(\s*(["'])(.*?)\1/g)) targets.push(match[2]!);
      for (const match of code.matchAll(/\bPath\s*\(\s*(["'])(.*?)\1\s*\)\s*\.\s*(?:write_text|write_bytes|unlink|rename)\s*\(/g)) targets.push(match[2]!);
    }
  }
  if (!["rm", "mv", "touch", "tee", "truncate", "install", "sed", "perl", "dd"].includes(name)) return targets;
  if (name === "install") {
    const target = args.findIndex((word) => ["-t", "--target-directory"].includes(word));
    const joined = args.find((word) => word.startsWith("--target-directory="));
    targets.push(...(target >= 0 ? args.slice(target + 1, target + 2) : joined ? [joined.slice(joined.indexOf("=") + 1)] : args.slice(-1)));
    return targets;
  }
  if (name === "sed") {
    for (const script of args) for (const part of script.split(/[;\n]/)) {
      const output = /^(?:(?:\d+(?:,\d+)?|\/[^/]*\/)\s*)?w\s+(.+)$/.exec(part.trim())
        ?? /^s([^\w\s\\])(?:\\.|(?!\1).)*\1(?:\\.|(?!\1).)*\1[0-9a-z]*w\s+(.+)$/.exec(part.trim());
      if (output) targets.push(output.at(-1)!);
    }
  }
  if (["sed", "perl"].includes(name) && !args.some((word) => /^-[a-zA-Z]*i/.test(word) || word.startsWith("--in-place"))) return targets;
  for (const arg of args) {
    if (name === "dd") { if (arg.startsWith("of=")) targets.push(arg.slice(3)); }
    // An empty word is no file: macOS's `sed -i '' 's/a/b/' file` names its backup suffix that way, and as a path it
    // was the project folder itself, so every such edit was refused as changing a configured check.
    else if (arg && !arg.startsWith("-")) targets.push(arg);
  }
  return targets;
}

/** The write tool's folder step. A folder that is there already is left alone: on Windows, mkdir of a drive root (a
 * file written in C:\) fails with EPERM even with recursive. `fs` is a test seam. */
export async function ensureFolder(directory: string, fs: { stat: typeof stat; mkdir: typeof mkdir } = { stat, mkdir }): Promise<void> {
  try { if ((await fs.stat(directory)).isDirectory()) return; } catch { /* not there yet */ }
  await fs.mkdir(directory, { recursive: true });
}

export function guardedFileTools(cwd: string, guard: CheckChangeGuard) {
  const signals = new AsyncLocalStorage<AbortSignal | undefined>();
  const write = (file: string, text: string) => guard.write(file, text, signals.getStore());
  return [
    createEditToolDefinition(cwd, { operations: {
      access: (file) => access(file, constants.R_OK | constants.W_OK),
      readFile: (file) => readFile(file),
      writeFile: write,
    } }),
    createWriteToolDefinition(cwd, { operations: {
      mkdir: (directory) => ensureFolder(directory),
      writeFile: write,
    } }),
  ].map((tool) => {
    const definition = tool as ToolDefinition;
    const execute: typeof definition.execute = async (id, input, signal, update, context) => {
      try { return await signals.run(signal, () => definition.execute(id, input, signal, update, context)); }
      catch (error) {
        if (!(error instanceof SessionOnlyCheck)) throw error;
        return { content: [{ type: "text", text: `– ${error.message}. Use the session-only command; do not try to save the file again this task.` }], details: { sessionOnlyCheck: true } };
      }
    };
    return { ...definition, execute };
  });
}
