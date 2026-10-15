import { constants } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
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
  ask(change: CheckChange): Promise<"save" | "session" | undefined>;
  /** Apply approved replacements to the current registries, for both saved and session-only changes. */
  useSessionCommands?(commands: Record<string, string>): void;
}

/** Native file operations call this inside Pi's mutation queue, with the actual final text (not a guessed edit).
 * Shell writes naming these files are refused: native edit/write can show the exact old → new before saving. */
export class CheckChangeGuard {
  constructor(private readonly root: string, private readonly options?: CheckChangeOptions) {}

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

  async write(file: string, after: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const identity = realpathLongest(file);
    if (!(await this.files()).has(identity)) { await writeFile(file, after, "utf8"); return; }
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
      throw new Error("Session-only check override applied; the file was not changed.");
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
    const { targets, unclearCopy } = shellWritePaths(command, this.root);
    const refusal = "Not run: this command may change a configured check. Use native edit/write so Casper can show old → new and ask 'Change the test check for this project?'";
    if (unclearCopy) return refusal;
    for (const file of await this.files()) {
      const relative = path.relative(realpathLongest(this.root), file);
      if (isOutside(relative)) continue;
      if (targets.some((target) => !isOutside(path.relative(realpathLongest(target), file)))) return refusal;
    }
    return undefined;
  }
}

/** Keep literal cd operands scoped to their shell; a copy's destination can replace all its descendants. */
function shellWritePaths(command: string, root: string): { targets: string[]; unclearCopy: boolean } {
  const targets: string[] = [];
  let unclearCopy = false;
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
          const moved = folders.map((folder) => path.resolve(folder, args[operand]!));
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
          if (/[$`~*?{}[\]]/.test(destination)) unclearCopy = true;
          operands.push(destination);
        }
      }
      for (const operand of operands) for (const folder of folders) targets.push(path.resolve(folder, operand));
      if (["sh", "bash", "dash", "zsh", "ksh", "ash", "fish"].includes(name)) {
        const flag = args.findIndex((word) => /^-[a-z]*c[a-z]*$/i.test(word));
        if (flag >= 0 && args[flag + 1]) visit(args[flag + 1]!, folders, depth + 1);
      } else {
        for (const nested of commandSegments(segment.text).slice(1)) visit(nested.text, folders, depth + 1);
      }
    }
  };
  visit(command, [root], 0);
  return { targets, unclearCopy };
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
    else if (!arg.startsWith("-")) targets.push(arg);
  }
  return targets;
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
      mkdir: async (directory) => { await mkdir(directory, { recursive: true }); },
      writeFile: write,
    } }),
  ].map((tool) => {
    const definition = tool as ToolDefinition;
    const execute: typeof definition.execute = (id, input, signal, update, context) =>
      signals.run(signal, () => definition.execute(id, input, signal, update, context));
    return { ...definition, execute };
  });
}
