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
  servers: string[];
  languageServers: string[];
  /** One-shot prompt, `casper learn …`, or an interactive session. */
  command: "prompt" | "learn" | "interactive";
  /** Prompt words, or the full `learn …` argument list. */
  rest: string[];
}

/** Every leading option the parser accepts; /help all must document each one. */
export const CLI_OPTIONS = ["--verify", "--no-verify", "--verbose", "--require-verification", "--mcp", "--lsp",
  "--help", "--version", "--licenses"] as const;

const SERVER_NAME = /^[a-zA-Z0-9_.][a-zA-Z0-9_.-]{0,63}$/;

/** Only *leading* arguments are options: `casper explain the -v flag` is a prompt, not a
 * version request. Pure: parsing touches no state, so a mistake costs nothing. */
export function parseCliArgs(argv: readonly string[]): CliOptions {
  const args = [...argv];
  const options: CliOptions = { verify: false, noVerify: false, verbose: false, requireVerification: false, servers: [], languageServers: [], command: "interactive", rest: [] };
  let optionCount = 0;
  for (;;) {
    const flag = args[0];
    if (flag === "--verify") options.verify = true;
    else if (flag === "--no-verify") options.noVerify = true;
    else if (flag === "--verbose") options.verbose = true;
    else if (flag === "--require-verification") options.requireVerification = true;
    else if (flag === "--mcp" || flag === "--lsp") {
      const name = args[1];
      // A following flag is not a name: `--mcp --verify` must fail, not connect to "--verify".
      if (!name || !SERVER_NAME.test(name)) throw new UsageError(`${flag} requires a configured server name`);
      const list = flag === "--lsp" ? options.languageServers : options.servers;
      if (!list.includes(name)) list.push(name);
      args.shift();
    } else break;
    args.shift();
    optionCount++;
  }

  const info = infoFlag(args[0]);
  if (info) return { ...options, info };
  if (args[0] === "--") args.shift();
  else if (args[0]?.startsWith("-")) {
    // An unknown or misspelled option would otherwise become a (paid) model prompt.
    throw new UsageError(`Unknown option ${args[0]}. Run casper --help for usage; put -- before a prompt that starts with "-".`);
  }
  if (options.verify && options.noVerify) throw new UsageError("--verify and --no-verify cannot be combined");

  options.rest = args;
  if (args[0] === "learn") {
    if (optionCount) throw new UsageError("learn cannot be combined with options");
    options.command = "learn";
  } else if (args.join(" ").trim()) options.command = "prompt";
  if (options.requireVerification && options.noVerify) throw new UsageError("--require-verification cannot be combined with --no-verify");
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
