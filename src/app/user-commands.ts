import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { isOutside } from "../platform/inside";
import { casperAgentDir } from "../runtime/agent-store";
import { findCommand } from "../tui/commands";
import { terminalText } from "../tui/format";

/** Your own slash command: a Markdown file in ~/.casper/commands (or Pi's ~/.casper/agent/prompts). Its name is the
 * file name; typing /name sends the file's text, with the words after the name put in for $1, $@ and $ARGUMENTS. */
export interface UserCommand {
  readonly name: string;
  readonly description: string;
  readonly argumentHint?: string;
  readonly content: string;
  readonly file: string;
}

/** Bigger files are left out: a command is a prompt, not a document. */
const MAX_COMMAND_BYTES = 256 * 1024;
/** A name the / menu and the command line can hold: one word, no controls. */
const COMMAND_NAME = /^[^\s/\\\p{Cc}]+$/u;

/** Where your commands live, first one wins a name: Casper's folder, then Pi's prompt templates in Casper's store.
 * A project's own folders are not read: a repository is never trusted to put words in your mouth. */
export function userCommandDirs(home: string): string[] {
  const override = process.env.CASPER_AGENT_DIR;
  const agentDir = override && override !== "undefined" ? casperAgentDir() : path.join(home, ".casper", "agent");
  return [path.join(home, ".casper", "commands"), path.join(agentDir, "prompts")];
}

/** A command file as you would type it, the same on every system: ~/.casper/commands/hello.md, with / even on Windows. */
export function commandFileShown(file: string, home: string): string {
  const relative = path.relative(home, file);
  return relative && !isOutside(relative) ? `~/${relative.split(path.sep).join("/")}` : file;
}

/** A menu or /help row's words on one line, with no terminal controls (a YAML "\e" or a line break would break the row). */
function oneLine(text: string): string {
  return terminalText(text).replace(/\s+/g, " ").trim();
}

/** The `description` and `argument-hint` lines, and the text after the frontmatter (as Pi reads a prompt template). */
function readCommand(file: string): UserCommand | undefined {
  const name = path.basename(file).replace(/\.md$/, "");
  if (!COMMAND_NAME.test(name)) return undefined;
  const source = readFileSync(file, "utf8").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  let fields: Record<string, unknown> = {};
  let body = source;
  const end = source.startsWith("---") ? source.indexOf("\n---", 3) : -1;
  if (end !== -1) {
    try { const value: unknown = parse(source.slice(4, end)); if (value && typeof value === "object") fields = value as Record<string, unknown>; }
    catch { return undefined; }
    body = source.slice(end + 4).trim();
  }
  const first = oneLine(body.split("\n").find((line) => line.trim()) ?? "");
  const description = typeof fields.description === "string" && oneLine(fields.description) ? oneLine(fields.description)
    : first.length > 60 ? `${first.slice(0, 60)}...` : first;
  const hint = typeof fields["argument-hint"] === "string" ? oneLine(fields["argument-hint"]) : "";
  return { name, description, ...(hint ? { argumentHint: hint } : {}), content: body, file };
}

/** Every command in your folders, read now (a file you just saved counts). One that can't be read is skipped. */
export function loadUserCommands(home: string): UserCommand[] {
  const found = new Map<string, UserCommand>();
  for (const directory of userCommandDirs(home)) {
    let names: string[];
    try { names = readdirSync(directory).filter((name) => name.endsWith(".md")).sort(); } catch { continue; }
    for (const name of names) {
      const file = path.join(directory, name);
      try {
        const info = statSync(file);
        if (!info.isFile() || info.size > MAX_COMMAND_BYTES) continue;
        const command = readCommand(file);
        if (command && !found.has(command.name)) found.set(command.name, command);
      } catch { /* unreadable: left out */ }
    }
  }
  return [...found.values()];
}

/** The words after a command's name, split as a shell would: quotes keep spaces together (Pi's parseCommandArgs). */
export function commandArgs(text: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (const char of text) {
    if (quote) { if (char === quote) quote = undefined; else current += char; }
    else if (char === "\"" || char === "'") quote = char;
    else if (/\s/.test(char)) { if (current) { args.push(current); current = ""; } }
    else current += char;
  }
  if (current) args.push(current);
  return args;
}

/** $1, $@, $ARGUMENTS, ${1:-default}, ${@:2} and ${@:2:1} filled in, as Pi fills a prompt template (substituteArgs). */
export function fillCommand(content: string, args: readonly string[]): string {
  const all = args.join(" ");
  return content.replace(/\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
    (_match, target?: string, fallback?: string, from?: string, length?: string, simple?: string) => {
      if (target) { const value = target === "@" || target === "ARGUMENTS" ? all : args[Number(target) - 1]; return value ? value : fallback ?? ""; }
      if (from) {
        const start = Math.max(0, Number(from) - 1);
        return (length ? args.slice(start, start + Number(length)) : args.slice(start)).join(" ");
      }
      if (simple === "ARGUMENTS" || simple === "@") return all;
      return args[Number(simple) - 1] ?? "";
    });
}

/** A typed line that runs one of your commands: the command and the text that goes to the model. A Casper command
 * of the same name always wins, so /help or /model can never be taken over. */
export function userCommandRequest(line: string, commands: readonly UserCommand[]): { command: UserCommand; text: string } | undefined {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(line.trim());
  if (!match || findCommand(match[1]!)) return undefined;
  const command = commands.find((entry) => entry.name === match[1]);
  return command && { command, text: fillCommand(command.content, commandArgs(match[2] ?? "")) };
}

/** Your commands that a Casper command does not hide, for the / menu and /help. */
export function usableCommands(commands: readonly UserCommand[]): UserCommand[] {
  return commands.filter((command) => !findCommand(command.name));
}

/** The "Your commands" group at the end of /help and /help all; nothing when you have none. */
export function userCommandsHelp(commands: readonly UserCommand[]): string {
  if (!commands.length) return "";
  const rows = commands.map((command) => {
    const label = `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`;
    const what = findCommand(command.name) ? `Hidden: Casper's /${command.name} has this name; rename ${path.basename(command.file)}` : command.description;
    return `  ${label.padEnd(32)} ${what}`.trimEnd();
  });
  return `\nYour commands (Markdown files in ~/.casper/commands; /name words sends the file with the words in it):\n${rows.join("\n")}\n`;
}
