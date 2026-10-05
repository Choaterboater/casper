import os from "node:os";
import path from "node:path";
import { privatePlaces, realpathLongest, within } from "../platform/project-paths";
import { splitShell } from "./remote";

/**
 * With no sandbox (Windows, bubblewrap missing), the AI's shell asks before each command. Two things keep that from
 * becoming dozens of boxes a task: commands that only read (ls, git status, grep) run without asking, and a "don't ask
 * again" answer covers a command prefix (npm test, git commit), never a whole interpreter or a whole multi-purpose tool.
 * A text check, not a shell parser, and an allow-list: each program and git subcommand names the options it may have,
 * and anything else (an unknown option, a VAR=value start, a glob, $ or ~) asks as before. Every file it names must
 * really be in the project (links resolved) and not private; a search of a folder that holds a private place asks.
 */

/** Where a read runs: the project, your home folder and the private places (the sandbox's denyRead). */
export interface ReadPlace { root: string; home?: string; denyRead?: readonly string[] }

interface Spec {
  /** Option letters with no value; they may be grouped (-la). */
  short?: string;
  /** Option letters that take a value, joined (-n5) or as the next word (-n 5). */
  value?: string;
  /** Option letters whose value, if any, is joined (-uno). */
  optional?: string;
  /** Long options: "--x" takes no value, "--x=" takes one (--x=v or --x v). */
  long?: readonly string[];
  /** -5 means a count (head -5). */
  number?: boolean;
  /** Any option is fine (echo -n). */
  anyOption?: boolean;
  /** What the other words are: files to check, plain text, or nothing allowed. */
  words?: "paths" | "text" | "none";
  /** The first word is a pattern, unless one of these options gave it. */
  pattern?: readonly string[];
  /** Options whose value is a file to check. */
  pathOptions?: readonly string[];
  /** It reads whole folders: a folder holding a private place asks (and no folder means this one). */
  recursive?: boolean | ((options: ReadonlySet<string>) => boolean);
  /** Words are only allowed with one of these options (git branch -l). */
  wordsOnlyWith?: readonly string[];
  maxWords?: number;
  /** A last check on the words (date's +FORMAT). */
  check?: (words: readonly string[]) => boolean;
}

const COLOR = ["--color", "--color=", "--colour", "--colour=", "--no-color"];
const CHECKSUM: Spec = { short: "btz", long: ["--binary", "--text", "--tag", "--zero"] };

/** Programs that only read, and the options each may have. */
const READERS: Record<string, Spec> = {
  ls: { short: "aAlhRtrSd1FGiknopsuUcmxCbBgqQvX", long: ["--all", "--almost-all", ...COLOR, "--human-readable", "--classify", "--group-directories-first",
    "--sort=", "--time-style=", "--reverse", "--recursive", "--directory", "--size", "--inode", "--full-time", "--format=", "--literal", "--quoting-style="],
    recursive: (options) => options.has("-R") || options.has("--recursive") },
  pwd: { short: "LP", words: "none" },
  cat: { short: "nbsAvETet", long: ["--number", "--number-nonblank", "--squeeze-blank", "--show-all", "--show-ends", "--show-tabs", "--show-nonprinting"] },
  head: { short: "qvz", value: "nc", number: true, long: ["--quiet", "--silent", "--verbose", "--zero-terminated", "--lines=", "--bytes="] },
  tail: { short: "qvzr", value: "nc", number: true, long: ["--quiet", "--silent", "--verbose", "--zero-terminated", "--lines=", "--bytes="] },
  wc: { short: "lcmwL", long: ["--lines", "--words", "--chars", "--bytes", "--max-line-length"] },
  nl: { short: "p", value: "bnwsvidhfl" },
  grep: grepSpec(), egrep: grepSpec(), fgrep: grepSpec(),
  rg: {
    short: "nilwvcFxSsuUHIoqNa0pP.", value: "efgtTABCmMdjr",
    long: ["--hidden", "--no-ignore", "--no-ignore-vcs", "--no-ignore-parent", "--files", "--count", "--count-matches", "--json", "--line-number",
      "--no-line-number", "--ignore-case", "--smart-case", "--case-sensitive", "--fixed-strings", "--word-regexp", "--line-regexp",
      "--files-with-matches", "--files-without-match", "--no-heading", "--heading", "--vimgrep", "--only-matching", "--stats", "--invert-match",
      "--multiline", "--no-messages", "--null", "--trim", "--column", "--no-filename", "--with-filename", "--unrestricted", "--pcre2", "--crlf",
      "--text", "--quiet", "--type-list", "--sort=", "--sortr=", "--glob=", "--iglob=", "--type=", "--type-not=", "--max-count=", "--context=",
      "--after-context=", "--before-context=", "--max-depth=", "--max-columns=", "--max-filesize=", "--regexp=", "--file=", "--threads=",
      "--replace=", "--encoding=", ...COLOR],
    pattern: ["-e", "-f", "--regexp", "--file", "--files", "--type-list"], pathOptions: ["-f", "--file"], recursive: true,
  },
  which: { short: "as", words: "text" }, whereis: { short: "bmsu", words: "text" },
  file: { short: "bikNnhL", long: ["--mime", "--mime-type", "--mime-encoding", "--brief"] },
  stat: { short: "Lltx", long: ["--dereference", "--terse", "--format=", "--printf="] },
  du: { short: "shacdkmxbHl", value: "d", long: ["--max-depth=", "--summarize", "--human-readable", "--apparent-size", "--all", "--total"], recursive: true },
  df: { short: "hHkiTPla", long: ["--human-readable", "--inodes", "--total", "--print-type"] },
  tree: { short: "adfiFpsughDCnJQN", value: "LIP", long: ["--gitignore", "--dirsfirst", "--noreport", "--du", "--charset="], recursive: true },
  echo: { anyOption: true, words: "text" }, printf: { anyOption: true, words: "text" },
  basename: { short: "az", value: "s", words: "text" }, dirname: { short: "z", words: "text" },
  realpath: { short: "eqsmLPz", long: ["--relative-to=", "--relative-base="], pathOptions: ["--relative-to", "--relative-base"] },
  readlink: { short: "fenmqsvz" },
  uname: { short: "asnrvmpio", long: ["--all"], words: "none" },
  whoami: { words: "none" }, id: { short: "unGgrz", words: "text" },
  date: { short: "uR", value: "dr", optional: "I", long: ["--utc", "--iso-8601", "--iso-8601=", "--rfc-3339=", "--rfc-email", "--date="],
    pathOptions: ["-r"], words: "text", check: (words) => words.every((word) => word.startsWith("+")) },
  hostname: { short: "sfidaIA", words: "none" },
  true: { anyOption: true, words: "text" }, false: { anyOption: true, words: "text" },
  sort: { short: "bdfgiMhnRrsuVcCz", value: "ktS", long: ["--numeric-sort", "--reverse", "--unique", "--human-numeric-sort", "--version-sort",
    "--ignore-case", "--general-numeric-sort", "--month-sort", "--stable", "--check", "--ignore-leading-blanks", "--dictionary-order",
    "--zero-terminated", "--key=", "--field-separator=", "--buffer-size=", "--parallel="] },
  cut: { short: "snz", value: "dfcb", long: ["--complement", "--only-delimited", "--zero-terminated", "--delimiter=", "--fields=", "--characters=",
    "--bytes=", "--output-delimiter="] },
  tr: { short: "cdsCt", words: "text" },
  diff: { short: "uqNawbBiEtTypcs", value: "UCIW", long: ["--unified", "--unified=", "--brief", ...COLOR, "--side-by-side", "--ignore-space-change",
    "--ignore-all-space", "--ignore-blank-lines", "--ignore-case", "--text", "--strip-trailing-cr", "--label=", "--new-file",
    "--report-identical-files", "--expand-tabs", "--ignore-matching-lines=", "--context", "--context=", "--suppress-common-lines", "--width=",
    "--minimal", "--normal"] },
  cmp: { short: "bls", value: "ni" },
  comm: { short: "123z", long: ["--check-order", "--nocheck-order", "--total", "--output-delimiter="] },
  md5sum: CHECKSUM, sha1sum: CHECKSUM, sha256sum: CHECKSUM, sha512sum: CHECKSUM, shasum: { ...CHECKSUM, value: "a" },
  // `uniq in out` writes its second file.
  uniq: { short: "cdDuiz", value: "fsw", long: ["--count", "--repeated", "--unique", "--ignore-case", "--skip-fields=", "--skip-chars=",
    "--check-chars="], maxWords: 1 },
};

function grepSpec(): Spec {
  // No -R or -d/-D: -R follows links inside folders, which can lead out of the project.
  return {
    short: "nirlLcwvEFPhHoqsIxzZTabUy", value: "efABCm",
    long: ["--line-number", "--ignore-case", "--recursive", "--files-with-matches", "--files-without-match", "--count", "--word-regexp",
      "--line-regexp", "--invert-match", "--extended-regexp", "--fixed-strings", "--perl-regexp", "--basic-regexp", "--no-filename",
      "--with-filename", "--only-matching", "--quiet", "--silent", "--no-messages", "--binary-files=", "--null", "--text", "--label=", "--include=",
      "--exclude=", "--exclude-dir=", "--max-count=", "--context=", "--after-context=", "--before-context=", "--regexp=", "--file=", ...COLOR],
    pattern: ["-e", "-f", "--regexp", "--file"], pathOptions: ["-f", "--file"],
    recursive: (options) => options.has("-r") || options.has("--recursive"),
  };
}

const DIFF_LONG = ["--stat", "--stat=", "--shortstat", "--numstat", "--name-only", "--name-status", "--summary", "--patch", "--no-patch", "--raw",
  "--cached", "--staged", "--word-diff", "--word-diff=", "--color-words", "--ignore-all-space", "--ignore-space-change", "--ignore-blank-lines",
  "--minimal", "--patience", "--histogram", "--diff-algorithm=", "--no-renames", "--find-renames", "--find-copies", "--check", "--exit-code",
  "--quiet", "--no-ext-diff", "--no-textconv", "--full-index", "--abbrev", "--abbrev=", "--relative", "--merge-base", "--compact-summary",
  "--dirstat", "--unified=", "--diff-filter=", "--ignore-submodules", ...COLOR];
const LOG_LONG = ["--oneline", "--graph", "--all", "--decorate", "--decorate=", "--no-decorate", "--reverse", "--first-parent", "--merges",
  "--no-merges", "--abbrev-commit", "--follow", "--topo-order", "--date-order", "--left-right", "--cherry-pick", "--boundary", "--full-history",
  "--source", "--branches", "--tags", "--remotes", "--no-walk", "--walk-reflogs", "--format=", "--pretty", "--pretty=", "--date=", "--author=",
  "--committer=", "--since=", "--until=", "--after=", "--before=", "--grep=", "--max-count=", "--skip=", "--all-match", "--invert-grep",
  "--regexp-ignore-case", "--simplify-by-decoration"];

/** git subcommands that only read, and their options. No -c, -C, --output, --ext-diff, --textconv, -O or --no-index:
 * those set a program to run, write a file or read outside the project. */
const GIT_READERS: Record<string, Spec> = {
  status: { short: "sbvz", optional: "u", long: ["--short", "--branch", "--porcelain", "--porcelain=", "--long", "--show-stash", "--ahead-behind",
    "--no-ahead-behind", "--renames", "--no-renames", "--untracked-files", "--untracked-files=", "--ignored", "--verbose"] },
  diff: { short: "pusbwRMz", value: "U", long: DIFF_LONG },
  log: { short: "psuwgiEFPMz", value: "nSGU", number: true, long: [...DIFF_LONG, ...LOG_LONG] },
  show: { short: "psuwMz", value: "nU", number: true, long: [...DIFF_LONG, ...LOG_LONG] },
  "rev-parse": { short: "q", long: ["--show-toplevel", "--abbrev-ref", "--abbrev-ref=", "--short", "--short=", "--git-dir", "--is-inside-work-tree",
    "--is-inside-git-dir", "--verify", "--symbolic-full-name", "--show-prefix", "--show-cdup", "--quiet", "--absolute-git-dir", "--git-common-dir",
    "--is-bare-repository"] },
  "ls-files": { short: "cdmoisuktvzf", long: ["--cached", "--deleted", "--modified", "--others", "--ignored", "--stage", "--unmerged",
    "--exclude-standard", "--full-name", "--error-unmatch", "--directory", "--no-empty-directory", "--eol", "--deduplicate"] },
  blame: { short: "wMCesltfnpb", value: "L", long: ["--porcelain", "--line-porcelain", "--show-email", "--show-name", "--show-number", "--root",
    "--abbrev=", "--date="] },
  describe: { long: ["--tags", "--always", "--long", "--all", "--dirty", "--dirty=", "--exact-match", "--first-parent", "--abbrev=", "--match=",
    "--exclude=", "--candidates="] },
  shortlog: { short: "sne", long: ["--summary", "--numbered", "--email", "--no-merges", "--all", "--format=", "--since=", "--until=", "--author=",
    "--group="] },
  grep: { short: "nilLcwvEFPhHIqopWz", value: "efABCm", long: ["--line-number", "--ignore-case", "--files-with-matches", "--files-without-match",
    "--count", "--word-regexp", "--invert-match", "--extended-regexp", "--fixed-strings", "--perl-regexp", "--basic-regexp", "--cached",
    "--untracked", "--full-name", "--heading", "--break", "--only-matching", "--show-function", "--function-context", "--all-match", "--and",
    "--or", "--not", "--column", "--null", "--quiet", "--recurse-submodules", "--exclude-standard", "--max-depth=", "--context=",
    "--after-context=", "--before-context=", "--max-count=", "--threads=", ...COLOR],
    pattern: ["-e", "-f"], pathOptions: ["-f"] },
  branch: { short: "arvl", long: ["--all", "--remotes", "--list", "--show-current", "--verbose", "--contains=", "--no-contains=", "--merged=",
    "--no-merged=", "--points-at=", "--sort=", "--format=", ...COLOR], wordsOnlyWith: ["-l", "--list"] },
  tag: { short: "l", optional: "n", long: ["--list", "--sort=", "--contains=", "--no-contains=", "--points-at=", "--merged=", "--no-merged=",
    "--format="], wordsOnlyWith: ["-l", "--list"] },
  remote: { short: "v", long: ["--verbose"], words: "none" },
  "ls-tree": { short: "rdtlz", long: ["--name-only", "--name-status", "--full-name", "--full-tree", "--abbrev", "--long"] },
  "cat-file": { short: "ptse" },
};

/** Files a read must not print to the AI, project or not: keys, logins and .env files. */
const PRIVATE_NAME = /(?:^|\/)(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|\.netrc|\.npmrc|\.pypirc|\.git-credentials|credentials(?:\.\w+)?)$/;

/** True when an unquoted * ? [ or { would make the shell pick the files: `cat .en*` can't be checked by its text. */
function hasGlob(text: string): boolean {
  let quote: string | undefined;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quote) { if (char === quote) quote = undefined; else if (char === "\\" && quote === "\"") index++; continue; }
    if (char === "'" || char === "\"") quote = char;
    else if (char === "\\") index++;
    else if ("*?[{".includes(char)) return true;
  }
  return false;
}

interface Place { root: string; realRoot: string; private: string[] }

function placeOf(where: ReadPlace | string | undefined): Place {
  const given = typeof where === "string" ? { root: where } : where;
  const root = path.resolve(given?.root ?? process.cwd());
  const home = given?.home ?? os.homedir();
  // ~/.casper as a whole: its settings, logins and remembered answers are not for a read that runs without asking.
  const deny = [...(given?.denyRead ?? []), path.join(home, ".casper")];
  const places = privatePlaces({ root, home, denyRead: deny }).flatMap((place) => place.paths);
  return { root, realRoot: realpathLongest(root), private: [...new Set(places)] };
}

/** A file word is fine when it, and where its links lead, is in the project and not private. `folder`: the command
 * reads all of it, so a private place inside counts too. */
function fileOk(word: string, place: Place, folder: boolean): boolean {
  if (word === "-") return true;
  const absolute = path.resolve(place.root, word);
  const real = realpathLongest(absolute);
  if (!within(place.root, absolute) || !within(place.realRoot, real)) return false;
  for (const candidate of [absolute, real]) {
    if (PRIVATE_NAME.test(candidate.split(path.sep).join("/"))) return false;
    if (place.private.some((entry) => within(entry, candidate) || (folder && within(candidate, entry)))) return false;
  }
  return true;
}

/** Checks one program's words against its spec. */
function allowed(spec: Spec, args: readonly string[], place: Place): boolean {
  const options = new Set<string>();
  const words: string[] = [];
  const files: string[] = [];
  const longs = spec.long ?? [];
  let index = 0;
  const takeValue = (name: string, joined: string | undefined): boolean => {
    let value = joined;
    if (value === undefined) { value = args[++index]; if (value === undefined) return true; }
    if (spec.pathOptions?.includes(name)) files.push(value);
    return true;
  };
  for (; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") { words.push(...args.slice(index + 1)); break; }
    if (!arg.startsWith("-") || arg === "-") { words.push(arg); continue; }
    if (spec.anyOption) continue;
    if (spec.number && /^-\d+$/.test(arg)) continue;
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const name = equals < 0 ? arg : arg.slice(0, equals);
      options.add(name);
      if (equals >= 0) {
        if (!longs.includes(`${name}=`)) return false;
        takeValue(name, arg.slice(equals + 1));
      } else if (longs.includes(name)) continue;
      else if (longs.includes(`${name}=`)) takeValue(name, undefined);
      else return false;
      continue;
    }
    const letters = arg.slice(1);
    for (let at = 0; at < letters.length; at++) {
      const letter = letters[at]!;
      const name = `-${letter}`;
      options.add(name);
      if (spec.short?.includes(letter)) continue;
      const rest = letters.slice(at + 1);
      if (spec.value?.includes(letter)) { takeValue(name, rest || undefined); break; }
      if (spec.optional?.includes(letter)) break;
      return false;
    }
  }
  if (spec.wordsOnlyWith && words.length && !spec.wordsOnlyWith.some((option) => options.has(option))) return false;
  if (spec.check && !spec.check(words)) return false;
  const kind = spec.words ?? "paths";
  if (kind === "none") return words.length === 0;
  if (spec.maxWords !== undefined && words.length > spec.maxWords) return false;
  if (!files.every((file) => fileOk(file, place, false))) return false;
  if (kind === "text") return true;
  const paths = spec.pattern && !spec.pattern.some((option) => options.has(option)) ? words.slice(1) : words;
  const recursive = typeof spec.recursive === "function" ? spec.recursive(options) : Boolean(spec.recursive);
  return (paths.length ? paths : recursive ? ["."] : []).every((word) => fileOk(word, place, recursive));
}

/** find: start folders, then tests and -print only. No -exec, -ok, -delete, -fprint, -L or -follow. */
const FIND_TESTS = new Set(["-print", "-print0", "-empty", "-prune", "-depth", "-not", "-o", "-a", "-or", "-and", "-true", "-false", "-readable",
  "-writable", "-executable", "-nouser", "-nogroup", "-xdev", "-mount", "-daystart", "-noleaf", "-quit", "-ls", "(", ")", "!", ","]);
const FIND_VALUE = new Set(["-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename", "-regex", "-iregex", "-type", "-xtype", "-maxdepth",
  "-mindepth", "-size", "-mtime", "-mmin", "-atime", "-amin", "-ctime", "-cmin", "-perm", "-user", "-group", "-uid", "-gid", "-links", "-inum",
  "-regextype", "-printf"]);
const FIND_FILE = new Set(["-samefile", "-newer", "-anewer", "-cnewer"]);

function findAllowed(args: readonly string[], place: Place): boolean {
  let index = 0;
  while (args[index] === "-P") index++;
  const starts: string[] = [];
  for (; index < args.length && !/^[-()!,]/.test(args[index]!); index++) starts.push(args[index]!);
  for (; index < args.length; index++) {
    const arg = args[index]!;
    if (FIND_TESTS.has(arg)) continue;
    if (FIND_VALUE.has(arg)) { index++; continue; }
    if (FIND_FILE.has(arg)) { const file = args[++index]; if (file !== undefined && !fileOk(file, place, false)) return false; continue; }
    return false;
  }
  return (starts.length ? starts : ["."]).every((word) => fileOk(word, place, true));
}

function readerSegment(words: string[], place: Place): boolean {
  const [name, ...args] = words;
  if (!name || name.includes("=") || name.includes("/") || name.includes("\\")) return false;
  // $HOME, ${X}, ~ and the like: the shell would change the word, so its text can't be checked.
  if (words.some((word) => word.includes("$") || word.startsWith("~"))) return false;
  if (name === "find") return findAllowed(args, place);
  if (name === "git") {
    let index = 0;
    while (args[index] === "--no-pager" || args[index] === "-P") index++;
    const sub = args[index];
    const spec = sub === undefined ? undefined : Object.hasOwn(GIT_READERS, sub) ? GIT_READERS[sub] : undefined;
    return Boolean(spec) && allowed(spec!, args.slice(index + 1), place);
  }
  const spec = Object.hasOwn(READERS, name) ? READERS[name] : undefined;
  return Boolean(spec) && allowed(spec!, args, place);
}

/** True when every command on the line only reads files in the project: no redirect, no substitution, no
 * background job, no glob, no option it doesn't know, nothing outside the project or private. Pipes and && between
 * readers are fine. `where`: the project folder, or the project, your home and the private places. */
export function readOnlyCommand(command: string, where?: ReadPlace | string): boolean {
  const text = command.trim();
  if (!text || /[<>`]|\$\(|(?:^|[^&])&(?!&)/.test(text) || hasGlob(text)) return false;
  const line = splitShell(text);
  if (!line.segments.length) return false;
  const place = placeOf(where);
  return line.segments.every((segment) => readerSegment(segment.words, place));
}

/** Programs that run whatever follows them, or can (an editor, a pager, curl, tar): never a prefix of their own, and
 * never part of one (yarn node, uv run python). Matched on the plain name, so python3.12, node.exe and PowerShell.exe
 * count too. */
const NO_PREFIX = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "python", "py", "pythonw", "ipython", "jupyter", "node", "deno", "ruby",
  "irb", "pry", "perl", "php", "lua", "java", "jshell", "julia", "rscript", "r", "swift", "kotlin", "scala", "groovy", "elixir", "iex", "erl",
  "ghci", "runghc", "tclsh", "wish", "expect", "pwsh", "powershell", "cmd", "sudo", "doas", "env", "xargs", "eval", "exec", "nohup", "time",
  "timeout", "watch", "nice", "npx", "bunx", "pnpx", "uvx", "source", ".", "ssh", "scp", "sftp", "rsync", "nc", "telnet", "socat", "curl", "wget",
  "awk", "gawk", "mawk", "nawk", "sed", "find", "tar", "zip", "less", "more", "man", "vi", "vim", "nvim", "emacs", "nano", "ed", "ex", "gdb",
  "lldb", "strace", "ltrace", "chroot", "unshare", "nsenter", "open", "xdg-open", "parallel", "flock", "unbuffer", "entr", "watchexec",
  "nodemon", "concurrently", "cross-env", "dotenv", "direnv", "nix", "nix-shell", "osascript", "tsx", "ts-node", "cscript", "wscript", "mshta",
  "rundll32", "start", "command", "busybox", "stdbuf", "setsid", "caffeinate", "ionice", "script"]);
/** Tools whose second word is a subcommand: the prefix keeps it (git commit, npm test, cargo build), and the tool
 * alone gets none. */
const SUBCOMMANDS = new Set(["git", "npm", "pnpm", "yarn", "bun", "cargo", "go", "docker", "podman", "kubectl", "pip", "pip3", "uv", "poetry",
  "pdm", "hatch", "rye", "pipx", "conda", "mise", "asdf", "dotnet", "mvn", "gradle", "brew", "apt", "apt-get", "systemctl", "gh", "terraform",
  "helm", "make", "deno"]);
/** Subcommands that run any script or program: the prefix keeps the next word too (npm run build, uv run pytest). */
const RUNNERS = new Set(["run", "exec", "x", "dlx", "tool"]);

/** The prefix a "don't ask again" answer covers: `npm test`, `git commit`, `npm run build`, `pytest`. Undefined for
 * a line with more than one command, a redirect or a substitution, a VAR=value start, an interpreter or a tool
 * with no subcommand: those are remembered as the exact command only. */
export function commandPrefix(command: string): string | undefined {
  const line = splitShell(command.trim());
  if (!line.simple) return undefined;
  const words = line.segments[0]?.words ?? [];
  const name = words[0];
  if (!name || name.includes("=")) return undefined;
  const plain = plainName(name);
  if (NO_PREFIX.has(plain)) return undefined;
  if (!SUBCOMMANDS.has(plain)) return name;
  // `git` alone, or `git -C sub commit`, `npm --prefix x test`, `cargo +nightly build`: the exact command only.
  if (!words[1] || !/^[A-Za-z]/.test(words[1])) return undefined;
  const prefix = RUNNERS.has(words[1]) ? (words[2] && !words[2].startsWith("-") ? words.slice(0, 3) : undefined) : words.slice(0, 2);
  // yarn node x.js, uv run python x.py: an interpreter inside is the exact command only.
  if (!prefix || prefix.slice(1).some((word) => NO_PREFIX.has(plainName(word)))) return undefined;
  return prefix.join(" ");
}

/** A program's plain name: no folder, no .exe/.cmd/.bat/.ps1, no version (python3.12, node20), lower case. */
function plainName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? name).toLowerCase().replace(/\.(?:exe|cmd|bat|com|ps1)$/, "");
  return base.replace(/[\d.-]+$/, "") || base;
}

/** True when `command` is one plain command starting with the prefix's words. */
export function matchesPrefix(command: string, prefix: string): boolean {
  const line = splitShell(command.trim());
  if (!line.simple) return false;
  const words = line.segments[0]?.words ?? [];
  const wanted = prefix.split(" ");
  return wanted.every((word, index) => words[index] === word);
}
