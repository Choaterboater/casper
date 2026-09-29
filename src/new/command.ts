import { lstat, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NEW_USAGE, type NewCommand } from "../cli-args";
import { formatNewProjectReceipt } from "./receipt";
import { createProject, tildePath, type NewProjectResult, type ToolRunner } from "./scaffold";
import { listTemplates } from "./templates";

/**
 * `casper new` from the command line. With a terminal the app asks for the kind and the name;
 * without one (scripts, CI) both are required: `casper new <template> <name>`. No model and no
 * runtime: exit 0 ready, 1 created but not ready (or a tool failed), 64 usage.
 */

export { NEW_USAGE, parseNewArgs, type NewCommand } from "../cli-args";
export const NEW_HELP_LINE = "casper new [name]    Start a new project (Python tool, MCP server, Mist scripts)";

/** One plain line per ready template. */
export function listLines(): string[] {
  const templates = listTemplates();
  const width = Math.max(...templates.map((t) => t.id.length)) + 2;
  return templates.map((t) => `${t.id.padEnd(width)}${t.title}. ${t.description}`);
}

export interface RunNewOptions {
  command: NewCommand;
  write: (line: string) => void;
  /** Home folder; the project goes in <home>/Projects. */
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  run?: ToolRunner;
  signal?: AbortSignal;
}

/** Where new projects go: ~/Projects, created when missing. */
export async function projectsFolder(home: string): Promise<string> {
  const parent = path.join(home, "Projects");
  const info = await lstat(parent).catch(() => undefined);
  if (!info) await mkdir(parent, { recursive: true });
  return parent;
}

export async function runNewCommand(options: RunNewOptions): Promise<{ exitCode: number; result?: NewProjectResult }> {
  const { command, write } = options;
  if (command.list) {
    for (const line of listLines()) write(line);
    return { exitCode: 0 };
  }
  if (!command.template || !command.name) {
    write(`casper new needs a template and a name when it can't ask. ${NEW_USAGE}`);
    write("Templates: " + listTemplates().map((t) => t.id).join(", "));
    return { exitCode: 64 };
  }
  const env = options.env ?? process.env;
  const home = options.homeDir ?? env.HOME ?? os.homedir();
  const parent = await projectsFolder(home);
  write(`Starting ${tildePath(path.join(parent, command.name), home)} from template ${command.template}`);
  const result = await createProject({
    parent, name: command.name, template: command.template, env, homeDir: home,
    onStep: write, ...(options.run ? { run: options.run } : {}), ...(options.signal ? { signal: options.signal } : {}),
  });
  for (const line of formatNewProjectReceipt(result)) write(line);
  return { exitCode: result.exitCode, result };
}
