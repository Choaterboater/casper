import { isEffortSelection } from "./runtime/model-routing";

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
  /** One-shot prompt, `casper learn …`, `casper mcp check …`, or an interactive session. */
  command: "prompt" | "learn" | "mcp-check" | "interactive";
  /** Prompt words, or the full `learn …` / `mcp check …` argument list. */
  rest: string[];
}

/** Every leading option the parser accepts; /help all must document each one. */
export const CLI_OPTIONS = ["--json", "--max-turns", "--cd", "--continue", "--resume", "--model", "--effort", "--verify", "--no-verify", "--verbose", "--require-verification", "--mcp", "--lsp",
  "--help", "--version", "--licenses"] as const;

/** Options that take a value, as `--name value` or `--name=value`. */
const VALUE_OPTIONS = new Set(["--max-turns", "--cd", "--resume", "--model", "--effort", "--mcp", "--lsp"]);

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
  if (args[0] === "--") args.shift();
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
  } else if (args[0] === "learn") {
    if (optionCount) throw new UsageError("learn cannot be combined with options");
    options.command = "learn";
  } else if (args[0] === "mcp" && args[1] === "check") {
    // Only exactly `mcp check`: `casper mcp docs are wrong` stays a prompt.
    if (optionCount) throw new UsageError(`mcp check takes its own flags. ${MCP_CHECK_USAGE}`);
    options.command = "mcp-check";
  } else if (args.join(" ").trim()) options.command = "prompt";
  if (options.requireVerification && options.noVerify) throw new UsageError("--require-verification cannot be combined with --no-verify");
  if (options.json && options.command !== "prompt") throw new UsageError("--json needs a prompt: casper --json \"fix the failing test\"");
  if (options.requireVerification && options.command !== "prompt") throw new UsageError("--require-verification needs a prompt: casper --require-verification \"fix the failing test\"");
  return options;
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
