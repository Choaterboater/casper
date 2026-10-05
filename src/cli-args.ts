import { statSync } from "node:fs";
import { isEffortSelection } from "./runtime/model-routing";
import { EMPTY_TEMPLATE, getTemplate, NAME_RULE, validName } from "./new/templates";

/** A command-line mistake: exits 64 (EX_USAGE), distinct from task results 1, 2 and 3. */
export class UsageError extends Error {
  override readonly name = "UsageError";
}

export type InfoFlag = "help" | "version" | "licenses";

export interface CliOptions {
  /** An informational flag: print and exit, nothing else runs and no conflict is checked. */
  info?: InfoFlag;
  verify: boolean;
  noVerify: boolean;
  /** --no-sandbox: shell commands and checks run with your own permissions for this run (said on the receipt). */
  noSandbox?: boolean;
  /** --allow-host <host>: the sandbox lets shell commands reach this host for this run, without asking. */
  allowHosts?: string[];
  /** --allow-write <folder>: shell commands and the AI's edits may write this folder outside the project, for this run. */
  allowWrites?: string[];
  /** --allow-reach <host>: the AI's ssh, scp and the like may reach this machine for this run, without asking. */
  allowReach?: string[];
  verbose: boolean;
  /** A one-shot run that ends without Casper's proof exits 3. Implies --verify. */
  requireVerification: boolean;
  /** This run's model selector (`provider/id[:effort]` or `@role`); never saved as the default. */
  model?: string;
  /** This run's reasoning effort; never remembered. */
  effort?: string;
  /** Work in this folder instead of the current directory. */
  cd?: string;
  /** JSON Lines events on stdout; the usual output moves to stderr. */
  json: boolean;
  /** Stop each model request after this many turns; the run is then incomplete (exit 2). */
  maxTurns?: number;
  /** Pick up the workspace's most recent conversation. */
  continueConversation: boolean;
  /** Pick up the saved conversation whose ID starts with this prefix. */
  resume?: string;
  servers: string[];
  languageServers: string[];
  /** A lone `-`: the one-shot prompt comes from stdin. Bun cannot retitle its process the way Node can, so a
   * prompt argument stays readable in the process list, and a model's `pkill -f <text from the prompt>` would
   * match Casper itself. */
  promptFromStdin?: boolean;
  /** One-shot prompt, a subcommand (`casper learn …`, `casper mcp check …`, `casper new …`,
   * `casper security …`, `casper update`), or an interactive session. */
  command: "prompt" | "interactive" | SubcommandName;
  /** Prompt words, or the subcommand's full argument list (starting with its own words). */
  rest: string[];
  /** A single word with no `--` before it: when it is a folder, `casper <folder>` opens it (cli.ts decides). */
  folderCandidate?: boolean;
}

export type SubcommandName = "learn" | "mcp-check" | "new" | "security" | "update";

/**
 * Casper's subcommands, matched in this order before anything is a prompt. Each one matches only its exact
 * words, so `casper new ideas for the app` or `casper security review of the login code` stay prompts. A
 * subcommand takes its own flags, so leading options are a usage mistake.
 */
export const SUBCOMMANDS: ReadonlyArray<{ name: SubcommandName; matches(args: readonly string[]): boolean; withOptions: string }> = [
  { name: "learn", matches: (args) => args[0] === "learn", withOptions: "learn cannot be combined with options" },
  // Only exactly `mcp check`: `casper mcp docs are wrong` stays a prompt.
  { name: "mcp-check", matches: (args) => args[0] === "mcp" && args[1] === "check", withOptions: "mcp check takes its own flags. " },
  { name: "new", matches: (args) => args[0] === "new" && parseNewArgs(args.slice(1)) !== null, withOptions: "new cannot be combined with options. " },
  { name: "security", matches: (args) => args[0] === "security" && isSecurityCommand(args.slice(1)), withOptions: "security takes its own flags. " },
  // `update` alone or with flags only: `casper update the readme` stays a prompt.
  { name: "update", matches: (args) => args[0] === "update" && args.slice(1).every((arg) => arg.startsWith("-")), withOptions: "update takes its own flags. " },
];

const USAGES: Record<SubcommandName, () => string> = {
  learn: () => "", "mcp-check": () => MCP_CHECK_USAGE, new: () => NEW_USAGE, security: () => SECURITY_USAGE, update: () => UPDATE_USAGE,
};

/** Every leading option the parser accepts; /help all must document each one. */
export const CLI_OPTIONS = ["--json", "--max-turns", "--cd", "--continue", "--resume", "--model", "--effort", "--verify", "--no-verify", "--no-sandbox", "--allow-host", "--allow-write", "--allow-reach", "--verbose", "--require-verification", "--mcp", "--lsp",
  "--help", "--version", "--licenses"] as const;

/** Options that take a value, as `--name value` or `--name=value`. */
const VALUE_OPTIONS = new Set(["--max-turns", "--cd", "--resume", "--model", "--effort", "--mcp", "--lsp", "--allow-host", "--allow-write", "--allow-reach"]);
/** The one-run allow flags: the option they fill and what their value names. */
const ALLOW_FLAGS = {
  "--allow-host": { key: "allowHosts", what: "a host", shown: "<host>" },
  "--allow-write": { key: "allowWrites", what: "a folder", shown: "<folder>" },
  "--allow-reach": { key: "allowReach", what: "a machine", shown: "<host>" },
} as const;

const SERVER_NAME = /^[a-zA-Z0-9_.][a-zA-Z0-9_.-]{0,63}$/;

/** Only *leading* arguments are options: `casper explain the -v flag` is a prompt, not a
 * version request. Pure: parsing touches no state, so a mistake costs nothing. */
export function parseCliArgs(argv: readonly string[]): CliOptions {
  const args = [...argv];
  const options: CliOptions = { verify: false, noVerify: false, verbose: false, requireVerification: false, json: false, continueConversation: false, servers: [], languageServers: [], command: "interactive", rest: [] };
  let optionCount = 0;
  for (;;) {
    let flag = args[0];
    let value: string | undefined;
    const equals = flag?.startsWith("--") ? flag.indexOf("=") : -1;
    if (equals > 0 && VALUE_OPTIONS.has(flag!.slice(0, equals))) {
      value = flag!.slice(equals + 1);
      flag = flag!.slice(0, equals);
      args.splice(0, 1, flag, value);
    } else if (flag && VALUE_OPTIONS.has(flag)) value = args[1];
    if (flag === "--verify") options.verify = true;
    else if (flag === "--no-verify") options.noVerify = true;
    else if (flag === "--no-sandbox") options.noSandbox = true;
    else if (flag === "--verbose") options.verbose = true;
    else if (flag === "--require-verification") options.requireVerification = true;
    else if (flag === "--continue") options.continueConversation = true;
    else if (flag === "--json") options.json = true;
    else if (flag === "--resume") {
      if (!value || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new UsageError("--resume needs the start of a conversation ID: --resume <id-prefix> (casper /resume lists them)");
      options.resume = value;
    }
    else if (flag === "--mcp" || flag === "--lsp") {
      // A following flag is not a name: `--mcp --verify` must fail, not connect to "--verify".
      if (!value || !SERVER_NAME.test(value)) throw new UsageError(`${flag} requires a configured server name`);
      const list = flag === "--lsp" ? options.languageServers : options.servers;
      if (!list.includes(value)) list.push(value);
    } else if (flag && flag in ALLOW_FLAGS) {
      const allow = ALLOW_FLAGS[flag as keyof typeof ALLOW_FLAGS];
      if (!value?.trim() || value.startsWith("-") || (allow.key !== "allowWrites" && /\s/.test(value))) throw new UsageError(`${flag} needs ${allow.what}: ${flag} ${allow.shown}`);
      const list = options[allow.key] ??= [];
      if (!list.includes(value.trim())) list.push(value.trim());
    } else if (flag === "--max-turns") {
      if (!value || !/^[1-9]\d{0,3}$/.test(value)) throw new UsageError("--max-turns needs a whole number from 1 to 9999");
      options.maxTurns = Number(value);
    } else if (flag === "--cd") {
      if (!value || value.startsWith("-")) throw new UsageError("--cd needs a folder: --cd <path>");
      options.cd = value;
    } else if (flag === "--model" || flag === "--effort") {
      if (!value?.trim() || value.startsWith("-")) throw new UsageError(`${flag} needs a value: ${flag === "--model" ? "--model provider/model-id[:effort]" : "--effort <level|auto>"}`);
      if (flag === "--effort" && !isEffortSelection(value)) throw new UsageError("--effort must be one of auto, off, minimal, low, medium, high, xhigh, max");
      options[flag === "--model" ? "model" : "effort"] = value.trim();
    } else break;
    args.splice(0, value === undefined ? 1 : 2);
    optionCount++;
  }

  const info = infoFlag(args[0]);
  if (info) return { ...options, info };
  const literal = args[0] === "--";
  if (literal) args.shift();
  else if (args[0]?.startsWith("-") && !(args[0] === "-" && args.length === 1)) {
    // An unknown or misspelled option would otherwise become a (paid) model prompt.
    throw new UsageError(`Unknown option ${args[0]}. Run casper --help for usage; put -- before a prompt that starts with "-".`);
  }
  if (options.verify && options.noVerify) throw new UsageError("--verify and --no-verify cannot be combined");
  if (options.continueConversation && options.resume) throw new UsageError("--continue and --resume cannot be combined");
  if (options.effort && options.model?.includes(":")) throw new UsageError("Give the effort either in --model provider/model-id:effort or in --effort, not both");

  options.rest = args;
  if (args.length === 1 && args[0] === "-") {
    options.promptFromStdin = true;
    options.rest = [];
    options.command = "prompt";
  } else if (subcommand(args)) {
    const found = subcommand(args)!;
    if (optionCount) throw new UsageError(`${found.withOptions}${USAGES[found.name]()}`.trim());
    options.command = found.name;
  } else if (args.join(" ").trim()) {
    options.command = "prompt";
    if (!literal) {
      // `casper ~/code/app` opens the folder; a known option after the words would otherwise be paid prompt text.
      if (args.length === 1) options.folderCandidate = true;
      trailingOption(args);
    }
  }
  if (options.requireVerification && options.noVerify) throw new UsageError("--require-verification cannot be combined with --no-verify");
  if (options.json && options.command !== "prompt") throw new UsageError("--json needs a prompt: casper --json \"fix the failing test\"");
  if (options.requireVerification && options.command !== "prompt") throw new UsageError("--require-verification needs a prompt: casper --require-verification \"fix the failing test\"");
  return options;
}

/** A known long option at the end of the prompt (`casper fix the bug --verify`) is a mistake, found before anything
 * runs. Short -v/-h and unknown dashes inside a prompt stay words ("explain the -v flag"). */
function trailingOption(args: readonly string[]): void {
  const last = args.at(-1)!;
  const before = args.at(-2);
  const known = (word: string) => (CLI_OPTIONS as readonly string[]).includes(word);
  const valued = /^(--[a-z-]+)=/.exec(last)?.[1];
  let options: string[] | undefined, words: readonly string[] = args;
  if (before && VALUE_OPTIONS.has(before)) { options = [before, last]; words = args.slice(0, -2); }
  else if (known(last) || (valued && VALUE_OPTIONS.has(valued))) { options = [last]; words = args.slice(0, -1); }
  if (!options) return;
  const quoted = (word: string) => /^[\w./:@%+=,-]+$/.test(word) ? word : JSON.stringify(word);
  // Quoting is the advice that works everywhere: Bun drops a leading -- when casper runs from source.
  throw new UsageError(`Options go before the prompt: casper ${options.map(quoted).join(" ")} ${JSON.stringify(words.join(" "))}. `
    + `To send it as words, quote the whole request: casper ${JSON.stringify(args.join(" "))}.`);
}

function subcommand(args: readonly string[]): (typeof SUBCOMMANDS)[number] | undefined {
  return SUBCOMMANDS.find((entry) => entry.matches(args));
}

function infoFlag(argument: string | undefined): InfoFlag | undefined {
  if (argument === "--help" || argument === "-h") return "help";
  if (argument === "--version" || argument === "-v") return "version";
  if (argument === "--licenses") return "licenses";
  return undefined;
}

export type LearnCommand =
  | { action: "generate"; repo: string }
  | { action: "list"; repo: string }
  | { action: "inspect"; repo: string; draftId: string }
  | { action: "promote"; repo: string; draftId: string; draftSha256: string; candidate: number;
    target: "reference" | "project-skill" | "global-skill" | "ignore"; skillName?: string };

export const LEARN_USAGE = "Usage: casper learn <local-repo> | learn list <local-repo> | learn inspect <local-repo> <draft-id> | learn promote <local-repo> <draft-id> <draft-sha256> <candidate-number> <reference|project-skill|global-skill|ignore> [skill-name]";

/** `rest` starts with "learn". A malformed form is a usage error, never a failed learning run. */
export function parseLearnArgs(rest: readonly string[]): LearnCommand {
  const [, action, ...args] = rest;
  if (action === "list" && args.length === 1) return { action, repo: args[0]! };
  if (action === "inspect" && args.length === 2) return { action, repo: args[0]!, draftId: args[1]! };
  if (action === "promote" && (args.length === 5 || args.length === 6)) {
    const [repo, draftId, draftSha256, candidate, target, skillName] = args as [string, string, string, string, string, string?];
    if (!["reference", "project-skill", "global-skill", "ignore"].includes(target)) throw new UsageError(LEARN_USAGE);
    return { action, repo, draftId, draftSha256, candidate: Number(candidate), target: target as "reference", skillName };
  }
  if (action && !args.length && !["list", "inspect", "promote"].includes(action) && !action.startsWith("-")) return { action: "generate", repo: action };
  throw new UsageError(LEARN_USAGE);
}

export interface McpCheckCommand {
  /** The repository folder; "." when not given. */
  repo: string;
  /** A configured server name to start instead of the repo's example config. */
  server?: string;
  /** Keep the real environment and allow a few read-only calls. Off by default. */
  live: boolean;
  /** Skip the full test run. */
  quick: boolean;
  /** Warnings also fail (exit 1). */
  strict: boolean;
  json: boolean;
  /** Extra environment for the repo's commands and the server, applied last. */
  env: Record<string, string>;
  /** Everything after `--`: the command that starts the server. */
  command?: string[];
}

export const MCP_CHECK_USAGE = "Usage: casper mcp check [repo] [--server <name>] [--live] [--quick] [--strict] [--json] [--env NAME=VALUE]... [-- <start command>...]";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `rest` starts with "mcp", "check". A malformed form is a usage error (exit 64), never a failed check. */
export function parseMcpCheckArgs(rest: readonly string[]): McpCheckCommand {
  const args = rest.slice(2);
  const result: McpCheckCommand = { repo: ".", live: false, quick: false, strict: false, json: false, env: {} };
  let repo: string | undefined;
  for (let index = 0; index < args.length; index++) {
    let arg = args[index]!;
    let value: string | undefined;
    const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
    if (equals > 0 && (arg.startsWith("--server=") || arg.startsWith("--env="))) {
      value = arg.slice(equals + 1);
      arg = arg.slice(0, equals);
    } else if (arg === "--server" || arg === "--env") {
      value = args[++index];
    }
    if (arg === "--") {
      const command = args.slice(index + 1);
      if (!command.length || !command[0]!.trim()) throw new UsageError(`Give the start command after --. ${MCP_CHECK_USAGE}`);
      result.command = command;
      break;
    }
    if (arg === "--live") result.live = true;
    else if (arg === "--quick") result.quick = true;
    else if (arg === "--strict") result.strict = true;
    else if (arg === "--json") result.json = true;
    else if (arg === "--server") {
      if (!value || !SERVER_NAME.test(value)) throw new UsageError(`--server needs a configured server name. ${MCP_CHECK_USAGE}`);
      result.server = value;
    } else if (arg === "--env") {
      const at = value?.indexOf("=") ?? -1;
      const name = at > 0 ? value!.slice(0, at) : "";
      if (!ENV_NAME.test(name)) throw new UsageError(`--env needs NAME=VALUE. ${MCP_CHECK_USAGE}`);
      result.env[name] = value!.slice(at + 1);
    } else if (arg.startsWith("-") || repo !== undefined || !arg.trim()) {
      throw new UsageError(MCP_CHECK_USAGE);
    } else repo = arg;
  }
  if (result.server && result.command) throw new UsageError(`--server and -- cannot be combined. ${MCP_CHECK_USAGE}`);
  if (repo !== undefined) result.repo = repo;
  return result;
}

export interface NewCommand {
  name?: string;
  template?: string;
  list: boolean;
  /** casper new --help: the usage and the kinds. */
  help?: boolean;
}

export const NEW_USAGE = "Usage: casper new [name] | casper new <template> <name> | casper new --list";

/**
 * `rest` is everything after `new`. Only `new`, `new <name>`, `new <template> <name>` and `new --list` are the
 * command; anything else ("new ideas for the app") stays a prompt (null). A single word that isn't a valid
 * name ("new ../x") is a usage mistake.
 */
export function parseNewArgs(rest: readonly string[]): NewCommand | null {
  if (rest.length === 0) return { list: false };
  if (rest.length === 1 && rest[0] === "--list") return { list: true };
  if (rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h")) return { list: false, help: true };
  if (rest.some((arg) => arg.startsWith("-"))) {
    throw new UsageError(`new takes no other options. ${NEW_USAGE}`);
  }
  // A lone kind word is the kind ("casper new web-app"); Casper asks for the name, or uses the kind's usual one.
  if (rest.length === 1 && (getTemplate(rest[0]!)?.manifest.ready || rest[0] === EMPTY_TEMPLATE)) return { template: rest[0]!, list: false };
  if (rest.length === 1) {
    const name = rest[0]!;
    if (!validName(name)) throw new UsageError(NAME_RULE);
    return { name, list: false };
  }
  if (rest.length === 2 && (getTemplate(rest[0]!) || rest[0] === EMPTY_TEMPLATE)) {
    const [template, name] = rest as [string, string];
    if (!validName(name)) throw new UsageError(NAME_RULE);
    return { template, name, list: false };
  }
  return null;
}

export interface SecurityCommand {
  /** The repository folder; "." when not given. */
  repo: string;
  json: boolean;
  /** A check that did not run, or a new ignore, also exits 1. */
  strict: boolean;
  /** Install missing tools first. A run without it never installs anything. */
  install: boolean;
  /** A saved tools/list reply of an MCP server: turns on mcp-scanner, which checks the tool descriptions. */
  mcpTools?: string;
}

export const SECURITY_USAGE = "Usage: casper security [repo] [--json] [--strict] [--install] [--mcp-tools <file>]";
const SECURITY_FLAGS = new Set(["--json", "--strict", "--install"]);
/** One word that can only be a path: it starts with / ./ ../ ~ or a drive (C:\\), or ends with a slash, and has no
 * spaces. `casper "fix src/app.py"` or `casper "Add POST /notes"` are prompts, never paths. */
export function looksLikePath(word: string): boolean {
  if (/\s/.test(word)) return false;
  return /^(?:\.{1,2}(?:[\\/]|$)|~(?:[\\/]|$)|[\\/]|[A-Za-z]:[\\/])/.test(word) || /[\\/]$/.test(word);
}
const PATH_LIKE = /^(?:\.{1,2}(?:[\\/]|$)|~(?:[\\/]|$)|[\\/]|[A-Za-z]:[\\/])|[\\/]/;

/** `security` alone, with its flags, or with one folder is the command; other words are a prompt. The folder
 * looks like a path (./app, ~/code/app) or is a folder that is there (`casper security app`), so a folder
 * name never turns into a paid prompt. */
function isSecurityCommand(rest: readonly string[]): boolean {
  const words = rest.filter((arg, index) => !arg.startsWith("-") && rest[index - 1] !== "--mcp-tools");
  return words.length === 0 || (words.length === 1 && ((!/\s/.test(words[0]!) && PATH_LIKE.test(words[0]!)) || isFolder(words[0]!)));
}

function isFolder(word: string): boolean {
  try { return statSync(word).isDirectory(); } catch { return false; }
}

/** `rest` starts with "security". A malformed form is a usage error (exit 64), never a failed check. */
export function parseSecurityArgs(rest: readonly string[]): SecurityCommand {
  const result: SecurityCommand = { repo: ".", json: false, strict: false, install: false };
  let repo: string | undefined;
  const args = rest.slice(1);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--mcp-tools") {
      const file = args[++index];
      if (!file || file.startsWith("-") || result.mcpTools !== undefined) throw new UsageError(SECURITY_USAGE);
      result.mcpTools = file;
    } else if (arg.startsWith("-")) {
      if (!SECURITY_FLAGS.has(arg)) throw new UsageError(`Unknown option ${arg}. ${SECURITY_USAGE}`);
      result[arg.slice(2) as "json" | "strict" | "install"] = true;
    } else if (repo !== undefined || !arg.trim()) throw new UsageError(SECURITY_USAGE);
    else repo = arg;
  }
  if (repo !== undefined) result.repo = repo;
  return result;
}

export interface UpdateCommand {
  /** Only say whether a newer Casper is out; change nothing. */
  check: boolean;
  /** casper update --help: what it does, and nothing else. */
  help?: boolean;
}

export const UPDATE_USAGE = "Usage: casper update [--check]";
/** What `casper update` does, for casper update --help and /help all. */
export const UPDATE_HELP = "Update Casper (no model): an installed release runs the newest release's own installer on this program's folder; a source checkout pulls with git (fast-forward only) and runs bun install when its lockfile changed. --check only says what is newer. Exit 0 updated or nothing to do, 1 not finished (the message says what is left), 64 usage mistake";

/** `rest` starts with "update". Anything but `--check` is a usage error (exit 64), never a lookup. */
export function parseUpdateArgs(rest: readonly string[]): UpdateCommand {
  const result: UpdateCommand = { check: false };
  for (const arg of rest.slice(1)) {
    if (arg === "--help" || arg === "-h") { result.help = true; continue; }
    if (arg !== "--check") throw new UsageError(`Unknown option ${arg}. ${UPDATE_USAGE}`);
    result.check = true;
  }
  return result;
}
