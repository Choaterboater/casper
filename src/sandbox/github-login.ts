import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { gitDirs, gitInternalPart, gitKeyRunsProgram, realpathLongest, within } from "../platform/project-paths";
import { isKeyFile, isSecretFile } from "../secrets/files";
import { splitShell } from "./remote";

/**
 * Plain git and gh commands that use your GitHub login: git push, pull, fetch, clone and ls-remote, and gh pr, issue,
 * run, repo view|clone, api (GET only) and auth status. The sandbox hides ~/.config/gh and git's saved logins, so these
 * fail inside it; after your yes Casper runs exactly that command outside the sandbox, with your own login, and the AI
 * reads only its output. Anything this does not read as one plain command of that kind stays in the sandbox.
 *
 * A strict text check, like the plain-ssh one (src/sandbox/remote.ts runsAlone): one command, no shell operators, no
 * $ or backquote, no variable in front, no git -c or global option, no option that makes git or gh run a program
 * (--upload-pack, --receive-pack, --template, -s <strategy>, --editor, --web), no file read from outside the project,
 * remotes only to network addresses, and nothing written outside the project.
 */

export interface GithubLoginCommand {
  tool: "git" | "gh";
  /** What a "for this session" or "always" answer covers: `git push`, `gh pr create`, `gh api`. */
  action: string;
  /** The command names an address itself (not a remote of this repo): a yes covers this command only. */
  address: boolean;
}

export interface GithubLoginPlaces {
  /** The project: a clone lands only inside it, a body file is read only from it or a place `readable` allows. */
  root: string;
  /** Where the command runs: inside the project, and no other repo between it and the project. */
  cwd: string;
  home?: string;
  /** A place a sandboxed command could not write (git's own files, private places). */
  writeBlocked?: (absolute: string) => boolean;
  /** A file outside the project a sandboxed command may read anyway (temp): a --body-file there is fine. */
  readable?: (absolute: string) => boolean;
  /** A private place the sandbox hides. */
  readBlocked?: (absolute: string) => boolean;
  /** The repo's remotes and their settings (tests); by default read from the project's .git/config. */
  remotes?: () => Map<string, Map<string, string[]>> | undefined;
}

/** Outside quotes: anything the shell expands or that starts another command. Inside double quotes: $, ` and \. */
const UNQUOTED_SPECIAL = /[$`*?[\]{}~#!<>|;&()\\]/;
const DOUBLE_SPECIAL = /[$`\\!]/;

/** The words of one plain command, or undefined when the shell would do anything more than run it as typed. */
function plainWords(command: string): string[] | undefined {
  let quote: string | undefined;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = undefined;
      else if (quote === "\"" && DOUBLE_SPECIAL.test(char)) return undefined;
      continue;
    }
    if (char === "'" || char === "\"") { quote = char; continue; }
    if (UNQUOTED_SPECIAL.test(char)) return undefined;
    // A newline, a no-break space or a form feed outside quotes: another command, or a word the box does not show.
    if (/\s/.test(char) && char !== " " && char !== "\t") return undefined;
  }
  if (quote) return undefined;
  const line = splitShell(command.trim());
  if (!line.simple) return undefined;
  const words = line.segments[0]?.words ?? [];
  return words.length >= 2 ? words : undefined;
}

/** An address git reaches over the network: https://, ssh:// (git+ssh://, git://) or user@host:path. Never a local
 * path, file://, or a <transport>::<address> that runs a helper program. */
export function networkAddress(url: string): boolean {
  if (url.includes("::") || /[\s\\]/.test(url)) return false;
  if (/^(?:https?|ssh|git\+ssh|ssh\+git|git):\/\/(?:[^@/\s]+@)?[A-Za-z0-9][A-Za-z0-9.-]*(?::\d+)?(?:\/\S*)?$/i.test(url)) return true;
  // scp-like: [user@]host:path, where git sees no slash before the colon. A one-letter host is a drive (C:/x) to git on
  // Windows, so not an address.
  return /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9.-]+:(?!\/\/)\S+$/.test(url);
}

/** The repo's remotes from its own config file (the sandbox keeps it read-only): name → key → values, lower-case keys. */
export function readRemotes(root: string): Map<string, Map<string, string[]>> | undefined {
  const dir = gitDirs(root).at(-1);
  if (!dir) return undefined;
  let text: string;
  try { text = readFileSync(path.join(dir, "config"), "utf8"); } catch { return undefined; }
  const remotes = new Map<string, Map<string, string[]>>();
  let current: Map<string, string[]> | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const section = /^\[\s*([^\s\]"]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]$/.exec(line);
    if (section) {
      current = undefined;
      if (section[1]!.toLowerCase() === "remote" && section[2] !== undefined) {
        const name = section[2].replace(/\\(.)/g, "$1");
        current = remotes.get(name) ?? new Map();
        remotes.set(name, current);
      } else if (/^remote\./i.test(section[1]!)) return undefined; // the old [remote.name] form: unclear, not plain
      continue;
    }
    if (line.startsWith("[")) { current = undefined; continue; }
    if (!current) continue;
    const entry = /^([A-Za-z][\w-]*)\s*(?:=\s*(.*))?$/.exec(line);
    if (!entry) return undefined;
    const value = (entry[2] ?? "").replace(/^"(.*)"$/, "$1");
    const key = entry[1]!.toLowerCase();
    current.set(key, [...current.get(key) ?? [], value]);
  }
  return remotes;
}

/** A remote git may use with your login: its addresses are network ones and it sets nothing that runs a program. */
function plainRemote(name: string, settings: Map<string, string[]> | undefined): boolean {
  if (!settings) return false;
  const urls = [...settings.get("url") ?? [], ...settings.get("pushurl") ?? []];
  if (!urls.length || !urls.every(networkAddress)) return false;
  // remote.<name>.vcs runs git-remote-<vcs>; uploadpack, receivepack and proxy are git's own "runs a program" keys.
  return ![...settings.keys()].some((key) => key === "vcs" || gitKeyRunsProgram(`remote.${name}.${key}`));
}

/** A branch, tag or refspec (`main`, `HEAD:refs/heads/x`, `+main`, `:old`), never an option. */
const REFSPEC = /^\+?[\w./@^~{}-]*(?::[\w./@-]*)?$/;
const REMOTE_NAME = /^[A-Za-z0-9][\w.-]*$/;

interface GitRules {
  /** Options that stand alone. */
  flags: readonly string[];
  /** Options that take the next word (or =value) as their value. */
  valued: readonly string[];
  /** Options that may carry =value (or stand alone). */
  optional?: readonly string[];
}

const VERBOSITY = ["-q", "--quiet", "-v", "--verbose", "--progress", "--no-progress"];
const FETCHING = ["--tags", "-t", "--no-tags", "--prune", "-p", "--prune-tags", "-P", "--force", "-f", "--unshallow", "--dry-run", "--atomic", "--all", "--no-write-fetch-head", "--set-upstream", "--refetch", "--update-shallow"];
const DEPTH = ["--depth", "--deepen", "--shallow-since", "--shallow-exclude"];
const GIT_RULES: Record<string, GitRules> = {
  push: {
    flags: [...VERBOSITY, "-u", "--set-upstream", "-f", "--force", "--force-if-includes", "--no-force-if-includes", "--tags", "--follow-tags", "--no-follow-tags",
      "-d", "--delete", "-n", "--dry-run", "--atomic", "--no-atomic", "--porcelain", "--no-verify", "--verify", "--prune", "--all", "--branches"],
    valued: ["-o", "--push-option"],
    optional: ["--force-with-lease"],
  },
  fetch: { flags: [...VERBOSITY, ...FETCHING], valued: DEPTH },
  pull: {
    flags: [...VERBOSITY, ...FETCHING, "-r", "--rebase", "--no-rebase", "--ff", "--no-ff", "--ff-only", "--no-edit", "--autostash", "--no-autostash",
      "--stat", "-n", "--no-stat", "--allow-unrelated-histories", "--commit", "--no-commit", "--squash", "--no-squash"],
    valued: DEPTH,
  },
  "ls-remote": { flags: ["-q", "--quiet", "-h", "--heads", "-b", "--branches", "-t", "--tags", "--refs", "--exit-code", "--symref", "--get-url"], valued: ["--sort"] },
  clone: {
    flags: [...VERBOSITY, "-n", "--no-checkout", "--single-branch", "--no-single-branch", "--no-tags", "--sparse"],
    valued: [...DEPTH, "-b", "--branch", "-o", "--origin", "--filter"],
  },
};
/** `git pull --rebase=merges` and the like: only git's own built-in values (interactive opens an editor). */
const REBASE_VALUE = /^--rebase=(?:true|false|merges)$/;
const FILTER_VALUE = /^(?:blob:none|tree:0|blob:limit=\d+[kmg]?)$/;

/** The options and the other words of a git or gh command, or undefined when an option is not on the list. */
function splitOptions(args: string[], rules: GitRules, extra?: (word: string) => boolean): { options: Array<[string, string | undefined]>; rest: string[] } | undefined {
  const options: Array<[string, string | undefined]> = [];
  const rest: string[] = [];
  for (let at = 0; at < args.length; at++) {
    const word = args[at]!;
    if (!word.startsWith("-") || word === "-") { rest.push(word); continue; }
    if (extra?.(word)) { options.push([word, undefined]); continue; }
    const eq = word.indexOf("=");
    const name = word.startsWith("--") && eq > 0 ? word.slice(0, eq) : word;
    const attached = word.startsWith("--") && eq > 0 ? word.slice(eq + 1) : undefined;
    if (rules.flags.includes(name) && attached === undefined) { options.push([name, undefined]); continue; }
    if (rules.optional?.includes(name)) { options.push([name, attached]); continue; }
    if (rules.valued.includes(name)) {
      const value = attached ?? args[++at];
      if (value === undefined || (attached === undefined && value.startsWith("-"))) return undefined;
      options.push([name, value]);
      continue;
    }
    return undefined;
  }
  return { options, rest };
}

/** The folder a clone makes: the one named, or the last part of the address without .git. Inside the project, new or
 * empty, and nowhere a sandboxed command couldn't write. */
function cloneTargetOk(address: string, named: string | undefined, places: GithubLoginPlaces): boolean {
  const human = named ?? address.replace(/[/\\]+$/, "").replace(/\.git$/i, "").split(/[/:\\]/).pop() ?? "";
  if (!human || human === "." || human === "..") return named === "." && emptyFolder(path.resolve(places.cwd)) && insideProject(places.cwd, places);
  const target = path.resolve(places.cwd, human);
  if (!insideProject(target, places)) return false;
  const real = realpathLongest(target);
  if (gitInternalPart(real, places.root, places.home) !== undefined || places.writeBlocked?.(real)) return false;
  try { statSync(real); } catch { return true; }
  return emptyFolder(real);
}

function emptyFolder(dir: string): boolean {
  try { return statSync(dir).isDirectory() && readdirSync(dir).length === 0; } catch { return false; }
}

function insideProject(absolute: string, places: GithubLoginPlaces): boolean {
  return within(realpathLongest(places.root), realpathLongest(absolute));
}

/** A file gh reads and sends (--body-file): in the project or a place a sandboxed command may read anyway, never a
 * private place or a key or login file. */
function readableFile(file: string, places: GithubLoginPlaces): boolean {
  if (file === "-" || /^~/.test(file)) return false;
  const real = realpathLongest(path.resolve(places.cwd, file));
  if (places.readBlocked?.(real) || isSecretFile(real) || isKeyFile(real)) return false;
  return insideProject(real, places) || places.readable?.(real) === true;
}

/** The command runs in the project, and no other repo sits between where it runs and the project (that repo's own
 * settings could be the AI's, and they would apply outside the sandbox). */
function runsInProject(places: GithubLoginPlaces): boolean {
  const root = realpathLongest(places.root);
  let dir = realpathLongest(places.cwd);
  if (!within(root, dir)) return false;
  while (dir !== root) {
    try { statSync(path.join(dir, ".git")); return false; } catch { /* none here */ }
    const up = path.dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
  return true;
}

function gitCommand(words: string[], places: GithubLoginPlaces): GithubLoginCommand | undefined {
  const sub = words[1]!;
  const rules = GIT_RULES[sub];
  if (!rules) return undefined;
  const split = splitOptions(words.slice(2), rules, (word) => sub === "pull" && REBASE_VALUE.test(word));
  if (!split) return undefined;
  if (split.options.some(([name, value]) => name === "--filter" && !FILTER_VALUE.test(value ?? ""))) return undefined;
  if (split.options.some(([name, value]) => (name === "-b" || name === "--branch" || name === "-o" || name === "--origin") && !REFSPEC.test(value ?? "-"))) return undefined;
  const [first, ...more] = split.rest;
  const action = `git ${sub}`;
  if (sub === "clone") {
    if (!first || !networkAddress(first) || more.length > 1) return undefined;
    if (more[0] !== undefined && (more[0].startsWith("-") || /^~/.test(more[0]))) return undefined;
    return cloneTargetOk(first, more[0], places) ? { tool: "git", action, address: true } : undefined;
  }
  if (more.some((word) => !REFSPEC.test(word))) return undefined;
  const remotes = (places.remotes ?? (() => readRemotes(places.root)))();
  if (first === undefined) {
    // No remote named: git picks one from the repo's settings, so every remote must be a plain one.
    if (!remotes?.size || ![...remotes].every(([name, settings]) => plainRemote(name, settings))) return undefined;
    return { tool: "git", action, address: false };
  }
  // A remote of this repo by name (git looks names up first), or a network address typed in the command.
  if (REMOTE_NAME.test(first) && remotes?.has(first)) return plainRemote(first, remotes.get(first)) ? { tool: "git", action, address: false } : undefined;
  if (networkAddress(first)) return { tool: "git", action, address: true };
  // Anything else (a folder, ../other.git, a name that is no remote) is a local path to git: its hooks would run here.
  return undefined;
}

/** gh subcommands that may run outside the sandbox, by group. */
const GH_SUBCOMMANDS: Record<string, readonly string[]> = {
  pr: ["list", "view", "status", "checks", "diff", "create", "comment", "edit", "merge", "close", "reopen", "ready", "review", "checkout"],
  issue: ["list", "view", "status", "create", "comment", "edit", "close", "reopen"],
  run: ["list", "view", "watch", "rerun", "cancel"],
  repo: ["view", "clone"],
  auth: ["status"],
};
/** gh options that open a browser or an editor, read stdin or a recovery file, or reach submodules: never outside. */
const GH_NEVER = new Set(["-w", "--web", "-e", "--editor", "--recover", "--recurse-submodules", "--"]);
const GH_FILE = new Set(["-F", "--body-file"]);
/** gh api: reads only. */
const GH_API: GitRules = {
  flags: ["--paginate", "--slurp", "-i", "--include", "--silent"],
  valued: ["-X", "--method", "-H", "--header", "-q", "--jq", "-t", "--template", "--hostname", "--cache", "-p", "--preview"],
};

function ghCommand(words: string[], places: GithubLoginPlaces): GithubLoginCommand | undefined {
  const group = words[1]!;
  if (group === "api") {
    const split = splitOptions(words.slice(2), GH_API);
    if (!split || split.rest.length !== 1) return undefined;
    const endpoint = split.rest[0]!;
    // graphql is a POST that can change things; a method other than GET changes things too.
    if (/^\/?graphql\b/i.test(endpoint) || split.options.some(([name, value]) => (name === "-X" || name === "--method") && value?.toUpperCase() !== "GET")) return undefined;
    return { tool: "gh", action: "gh api", address: false };
  }
  const sub = words[2];
  if (!sub || !GH_SUBCOMMANDS[group]?.includes(sub)) return undefined;
  const args = words.slice(3);
  const action = `gh ${group} ${sub}`;
  if (group === "auth") {
    const split = splitOptions(args, { flags: ["-a", "--active"], valued: ["-h", "--hostname"] });
    return split && !split.rest.length ? { tool: "gh", action, address: false } : undefined;
  }
  // gh repo clone's own options (-u <name>) and the git options after -- would hide which folder it makes.
  if (group === "repo" && sub === "clone" && args.some((word) => word.startsWith("-"))) return undefined;
  const rest: string[] = [];
  for (let at = 0; at < args.length; at++) {
    const word = args[at]!;
    if (!word.startsWith("-") || word === "-") { rest.push(word); continue; }
    const name = word.startsWith("--") && word.includes("=") ? word.slice(0, word.indexOf("=")) : word;
    if (GH_NEVER.has(name)) return undefined;
    // -wF and -Fbody.md read as several short options or one with its value: unclear, so not plain.
    if (!word.startsWith("--") && word.length > 2 && !/^-\d+$/.test(word)) return undefined;
    if (GH_FILE.has(name)) {
      const file = name === word ? args[++at] : word.slice(name.length + 1);
      if (file === undefined || !readableFile(file, places)) return undefined;
    }
  }
  if (group === "repo" && sub === "clone") {
    const [repo, dir, ...extra] = rest;
    if (!repo || extra.length || !/^(?:[\w.-]+\/)?[\w.-]+(?:\/[\w.-]+)?$|^https:\/\/\S+$/.test(repo)) return undefined;
    return cloneTargetOk(repo, dir, places) ? { tool: "gh", action, address: true } : undefined;
  }
  return { tool: "gh", action, address: false };
}

/**
 * The plain git or gh command that may run outside the sandbox with your GitHub login, after you say yes; undefined
 * for anything else (which stays in the sandbox, where your login is hidden).
 */
export function githubLoginCommand(command: string, places: GithubLoginPlaces): GithubLoginCommand | undefined {
  const words = plainWords(command);
  // The bare name only: a ./git or bin/gh is a program from somewhere else (trustedProgram checks the PATH).
  if (!words || (words[0] !== "git" && words[0] !== "gh") || !runsInProject(places)) return undefined;
  return words[0] === "git" ? gitCommand(words, places) : ghCommand(words, places);
}

/** Whether a command starts git or gh anywhere (a pipe, a `cd x &&` in front): for the note that says how to run it. */
export function startsGitOrGh(command: string): boolean {
  return splitShell(command).segments.some((segment) => {
    const name = path.basename((segment.words.find((word) => !/^[A-Za-z_]\w*=/.test(word)) ?? "").replaceAll("\\", "/")).replace(/\.exe$/i, "");
    return name === "git" || name === "gh";
  });
}

/** What git or gh print when they could not use a login: the sandbox hid ~/.config/gh or git's saved logins. */
export const LOGIN_FAILED = /could not read (?:Username|Password)|Authentication failed|terminal prompts disabled|failed to load config|gh auth login|not logged (?:in|into)|\.config\/gh|git-credentials|HTTP Basic: Access denied|Permission denied \(publickey/i;

/** Settings for the git that runs outside the sandbox (for gh, the git it starts): no file:// or ext:: transport and no
 * submodules, whatever a file in the project says. Added after any you set yourself (GIT_CONFIG_COUNT). */
export function githubRunEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const pairs: Array<[string, string]> = [["protocol.file.allow", "never"], ["protocol.ext.allow", "never"], ["submodule.recurse", "false"], ["fetch.recurseSubmodules", "false"]];
  const start = /^\d+$/.test(env.GIT_CONFIG_COUNT ?? "") ? Number(env.GIT_CONFIG_COUNT) : 0;
  const out: Record<string, string> = { GIT_CONFIG_COUNT: String(start + pairs.length), GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" };
  pairs.forEach(([key, value], index) => { out[`GIT_CONFIG_KEY_${start + index}`] = key; out[`GIT_CONFIG_VALUE_${start + index}`] = value; });
  return out;
}
