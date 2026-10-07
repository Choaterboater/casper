import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
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
  /** It prints what is in the files it reads (grep, rg, git grep): a whole-folder read asks when a .env or key is inside. */
  contents?: boolean;
  /** git: the words may be pathspecs, which git expands itself (* ? [): one with such a character asks. */
  pathspec?: boolean;
  /** Words are only allowed with one of these options (git branch -l). */
  wordsOnlyWith?: readonly string[];
  maxWords?: number;
  /** Every file word must be a regular file or not exist (a folder or a device asks). */
  regularFiles?: boolean;
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
    pattern: ["-e", "-f", "--regexp", "--file", "--files", "--type-list"], pathOptions: ["-f", "--file"], recursive: true, contents: true,
  },
  which: { short: "as", words: "text" }, whereis: { short: "bmsu", words: "text" },
  file: { short: "bikNnhL", long: ["--mime", "--mime-type", "--mime-encoding", "--brief"] },
  stat: { short: "Lltx", long: ["--dereference", "--terse", "--format=", "--printf="] },
  du: { short: "shacdkmxbHl", value: "d", long: ["--max-depth=", "--summarize", "--human-readable", "--apparent-size", "--all", "--total"], recursive: true },
  df: { short: "hHkiTPla", long: ["--human-readable", "--inodes", "--total", "--print-type"] },
  tree: { short: "adfiFpsughDCnJQN", value: "LIP", long: ["--gitignore", "--dirsfirst", "--noreport", "--du", "--charset="], recursive: true },
  echo: { anyOption: true, words: "text" },
  // printf -v NAME assigns a shell variable (PATH, IFS, BASH_ENV...) that the next command then uses: no options at all.
  // The format's %n assigns the count of printed characters to the variable named by the next word (bash), so it asks too.
  printf: { words: "text", check: (words) => !/%[^a-zA-Z\\]*[hlLqjzt]*n/.test(words[0] ?? "") },
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
  // Files only (regularFiles): given a folder, diff compares the files inside it, and a link in there can lead out of the project.
  diff: { regularFiles: true, short: "uqawbBiEtTypcs", value: "UCIW", long: ["--unified", "--unified=", "--brief", ...COLOR, "--side-by-side", "--ignore-space-change",
    "--ignore-all-space", "--ignore-blank-lines", "--ignore-case", "--text", "--strip-trailing-cr", "--label=",
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
    recursive: (options) => options.has("-r") || options.has("--recursive"), contents: true,
  };
}

const DIFF_LONG = ["--stat", "--stat=", "--shortstat", "--numstat", "--name-only", "--name-status", "--summary", "--patch", "--no-patch", "--raw",
  "--cached", "--staged", "--word-diff", "--word-diff=", "--color-words", "--ignore-all-space", "--ignore-space-change", "--ignore-blank-lines",
  "--minimal", "--patience", "--histogram", "--diff-algorithm=", "--no-renames", "--find-renames", "--find-copies", "--check", "--exit-code",
  "--quiet", "--no-ext-diff", "--no-textconv", "--full-index", "--abbrev", "--abbrev=", "--relative", "--merge-base", "--compact-summary",
  "--dirstat", "--unified", "--unified=", "--diff-filter=", "--ignore-submodules", ...COLOR];
const LOG_LONG = ["--oneline", "--graph", "--all", "--decorate", "--decorate=", "--no-decorate", "--reverse", "--first-parent", "--merges",
  "--no-merges", "--abbrev-commit", "--follow", "--topo-order", "--date-order", "--left-right", "--cherry-pick", "--boundary", "--full-history",
  "--source", "--branches", "--tags", "--remotes", "--no-walk", "--walk-reflogs", "--format=", "--pretty", "--pretty=", "--date=", "--author=",
  "--committer=", "--since=", "--until=", "--after=", "--before=", "--grep=", "--max-count=", "--skip=", "--all-match", "--invert-grep",
  "--regexp-ignore-case", "--simplify-by-decoration"];

/** git subcommands that only read, and their options. No -c, -C, --output, --ext-diff, --textconv, -O or --no-index:
 * those set a program to run, write a file or read outside the project. -U, --unified and --abbrev take a value only
 * when it is joined (-U5, --abbrev=7), as git reads them: the word after them is a file and is checked. */
const GIT_READERS: Record<string, Spec> = {
  status: { pathspec: true, short: "sbvz", optional: "u", long: ["--short", "--branch", "--porcelain", "--porcelain=", "--long", "--show-stash", "--ahead-behind",
    "--no-ahead-behind", "--renames", "--no-renames", "--untracked-files", "--untracked-files=", "--ignored", "--verbose"] },
  diff: { pathspec: true, short: "pusbwRMz", optional: "U", long: DIFF_LONG },
  log: { pathspec: true, short: "psuwgiEFPMz", value: "nSG", optional: "U", number: true, long: [...DIFF_LONG, ...LOG_LONG] },
  show: { pathspec: true, short: "psuwMz", value: "n", optional: "U", number: true, long: [...DIFF_LONG, ...LOG_LONG] },
  "rev-parse": { short: "q", long: ["--show-toplevel", "--abbrev-ref", "--abbrev-ref=", "--short", "--short=", "--git-dir", "--is-inside-work-tree",
    "--is-inside-git-dir", "--verify", "--symbolic-full-name", "--show-prefix", "--show-cdup", "--quiet", "--absolute-git-dir", "--git-common-dir",
    "--is-bare-repository"] },
  "ls-files": { short: "cdmoisuktvzf", long: ["--cached", "--deleted", "--modified", "--others", "--ignored", "--stage", "--unmerged",
    "--exclude-standard", "--full-name", "--error-unmatch", "--directory", "--no-empty-directory", "--eol", "--deduplicate"] },
  blame: { pathspec: true, short: "wMCesltfnpb", value: "L", long: ["--porcelain", "--line-porcelain", "--show-email", "--show-name", "--show-number", "--root",
    "--abbrev", "--abbrev=", "--date="] },
  describe: { long: ["--tags", "--always", "--long", "--all", "--dirty", "--dirty=", "--exact-match", "--first-parent", "--abbrev", "--abbrev=", "--match=",
    "--exclude=", "--candidates="] },
  shortlog: { short: "sne", long: ["--summary", "--numbered", "--email", "--no-merges", "--all", "--format=", "--since=", "--until=", "--author=",
    "--group="] },
  // No --cached: it searches the index, which can hold a private file that is deleted from the work tree (the whole-folder rule only sees the work tree).
  grep: { pathspec: true, short: "nilLcwvEFPhHIqopWz", value: "efABCm", long: ["--line-number", "--ignore-case", "--files-with-matches", "--files-without-match",
    "--count", "--word-regexp", "--invert-match", "--extended-regexp", "--fixed-strings", "--perl-regexp", "--basic-regexp",
    "--untracked", "--full-name", "--heading", "--break", "--only-matching", "--show-function", "--function-context", "--all-match", "--and",
    "--or", "--not", "--column", "--null", "--quiet", "--recurse-submodules", "--exclude-standard", "--max-depth=", "--context=",
    "--after-context=", "--before-context=", "--max-count=", "--threads=", ...COLOR],
    pattern: ["-e", "-f"], pathOptions: ["-f"], recursive: true, contents: true },
  branch: { short: "arvl", long: ["--all", "--remotes", "--list", "--show-current", "--verbose", "--contains=", "--no-contains=", "--merged=",
    "--no-merged=", "--points-at=", "--sort=", "--format=", ...COLOR], wordsOnlyWith: ["-l", "--list"] },
  tag: { short: "l", optional: "n", long: ["--list", "--sort=", "--contains=", "--no-contains=", "--points-at=", "--merged=", "--no-merged=",
    "--format="], wordsOnlyWith: ["-l", "--list"] },
  remote: { short: "v", long: ["--verbose"], words: "none" },
  "ls-tree": { short: "rdtlz", long: ["--name-only", "--name-status", "--full-name", "--full-tree", "--abbrev", "--long"] },
  "cat-file": { short: "ptse" },
};

/** Files a read must not print to the AI, project or not: keys, logins, .env files and secrets files. Not *.ini,
 * *.properties or a plain *.pem (CA bundles): most repos have those, and every search of the project would ask. */
const PRIVATE_NAME = /(?:^|\/)(?:\.env(?:\..*)?|[^/]*\.env|\.envrc|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|\.netrc|_netrc|\.npmrc|\.pypirc|\.pgpass|\.dockercfg|\.git-credentials|[^/]*credentials(?:\.\w+)?|\.?secrets?\.(?:ya?ml|json|toml|env|txt)|[^/]*\.(?:key|p12|pfx|ppk|tfvars|tfstate(?:\.backup)?|ovpn)|[^/]*key[^/]*\.pem)$/i;

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

/** A ".." is only plain text when nothing before it can be a link: leading ../ steps (with a root that is not itself
 * reached through a link) are fine; a ".." after a name is not, since the kernel follows the link first (sshl/.. is
 * not the project). */
function plainDots(word: string, place: Place): boolean {
  const parts = word.split("/");
  let index = 0;
  while (index < parts.length && (parts[index] === ".." || parts[index] === "." || parts[index] === "")) index++;
  if (parts.slice(index).includes("..")) return false;
  return !parts.includes("..") || place.root === place.realRoot;
}

/** On NTFS, `.env::$DATA` (a data stream) and `.env `, `.env.` (a trailing space or dot is dropped) open the same file as `.env`.
 * A file operand with a colon (but a drive letter and a slash, C:/x) or a name ending in a space or a dot (not . or ..) asks,
 * on every OS: cheap and fails closed. Pattern arguments are never checked here. */
function plainWindowsName(word: string): boolean {
  const parts = word.split("/");
  return parts.every((part, at) => {
    if (part.includes(":") && !(at === 0 && parts.length > 1 && /^[A-Za-z]:$/.test(part))) return false;
    return part === "." || part === ".." || !(part.endsWith(" ") || part.endsWith("."));
  });
}

/** A file word is fine when it, and where its links lead, is in the project and not private. `folder`: the command
 * reads all of it, so a private place inside counts too. */
function fileOk(word: string, place: Place, folder: boolean, contents = false, windowsNames = true): boolean {
  if (word === "-") return true;
  // A backslash is a separator on Windows (Git Bash): a path word with one can't be checked by its text.
  if (word.includes("\\") || !plainDots(word, place)) return false;
  if (windowsNames && !plainWindowsName(word)) return false;
  const absolute = path.resolve(place.root, word);
  const real = realpathLongest(absolute);
  if (!within(place.root, absolute) || !within(place.realRoot, real)) return false;
  for (const candidate of [absolute, real]) {
    if (PRIVATE_NAME.test(candidate.split(path.sep).join("/"))) return false;
    if (place.private.some((entry) => within(entry, candidate) || (folder && within(candidate, entry)))) return false;
  }
  return !(folder && contents && holdsPrivateFile(real));
}

/** Folders skipped when looking for a private file inside: git's own data, and installed packages. */
const SKIP_FOLDERS = new Set([".git", "node_modules"]);
/** More entries than this and the folder counts as holding one: asking costs less than walking a huge tree. */
const MAX_ENTRIES = 20_000;

/** True when a .env, key or login file is somewhere inside `folder` (links are not followed, as grep -r and rg don't). */
function holdsPrivateFile(folder: string): boolean {
  let seen = 0;
  const stack = [folder];
  while (stack.length) {
    const current = stack.pop()!;
    let names: string[];
    try {
      if (!lstatSync(current).isDirectory()) return PRIVATE_NAME.test(current.split(path.sep).join("/"));
      names = readdirSync(current);
    } catch { continue; }
    for (const name of names) {
      if (++seen > MAX_ENTRIES) return true;
      const full = path.join(current, name);
      if (PRIVATE_NAME.test(full.split(path.sep).join("/"))) return true;
      if (SKIP_FOLDERS.has(name)) continue;
      try { if (lstatSync(full).isDirectory()) stack.push(full); } catch { /* gone or unreadable */ }
    }
  }
  return false;
}

/** Checks one program's words against its spec. `git`: a word with a colon in it (rev:path, :path, ::path, :(magic), a colon inside braces) asks. */
function allowed(spec: Spec, args: readonly string[], place: Place, git = false): boolean {
  const options = new Set<string>();
  const words: string[] = [];
  const files: string[] = [];
  let dashAt = Infinity;
  const longs = spec.long ?? [];
  let index = 0;
  // A value given as the next word is never an option: `git diff -U --no-index` would hide --no-index from this
  // check while git reads it. A number (head -n -5, tail -n +5) is fine.
  const takeValue = (name: string, joined: string | undefined): boolean => {
    let value = joined;
    if (value === undefined) {
      value = args[++index];
      if (value === undefined) return true;
      if (value.startsWith("-") && !/^[-+]\d+$/.test(value)) return false;
    }
    if (spec.pathOptions?.includes(name)) files.push(value);
    return true;
  };
  for (; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") { dashAt = words.length; words.push(...args.slice(index + 1)); break; }
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
      else if (longs.includes(`${name}=`)) { if (!takeValue(name, undefined)) return false; }
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
      if (spec.value?.includes(letter)) { if (!takeValue(name, rest || undefined)) return false; break; }
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
  const skip = spec.pattern && !spec.pattern.some((option) => options.has(option)) ? 1 : 0;
  const given = words.slice(skip);
  // git reads rev:path, :path (short magic), ::path and :(magic) from any word, before or after `--`, so any git word that
  // is not an option and has a colon in it asks. Option values (--grep=a:b, -S a:b, -e a:b) are not words.
  if (git && given.some((word) => word.includes(":"))) return false;
  // After `--` every word is a pathspec; before it a word may also be a revision.
  const afterDash = (at: number) => at + skip >= dashAt;
  // git expands * ? [ in a pathspec itself (git grep -- '.en*' prints .env): the text check can't follow that.
  if (git && spec.pathspec && given.some((word) => /[*?[]/.test(word))) return false;
  const paths = given;
  const recursive = typeof spec.recursive === "function" ? spec.recursive(options) : Boolean(spec.recursive);
  if (spec.regularFiles && !paths.every((word) => word === "-" || isRegularFile(path.resolve(place.root, word)))) return false;
  const list = paths.length ? [...paths] : recursive ? ["."] : [];
  // git grep REV with no path in the project and none after `--` searches that revision's whole tree (HEAD:.env): the
  // whole-folder rule applies, as it does for `git grep X` with no word at all.
  if (git && spec.contents && paths.length && given.some((word, at) => !afterDash(at) && !existsInProject(word, place))
    && !given.some((word, at) => afterDash(at) || existsInProject(word, place))) list.push(".");
  return list.every((word) => fileOk(word, place, recursive, Boolean(spec.contents), !git));
}

/** True when the word names something that is there in the project (links not followed): then it is a path, not a revision. */
function existsInProject(word: string, place: Place): boolean {
  try { lstatSync(path.resolve(place.root, word)); return true; } catch { return false; }
}

/** True when the path (links followed) is a regular file, or is not there at all (the program only reports that). */
function isRegularFile(file: string): boolean {
  try { return statSync(file).isFile(); } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
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
  // A word starting with ~ (even a quoted one: the text check would read it as a folder named ~). A $ can only be here
  // from inside single quotes (safeLine refuses every other one), where it is plain text.
  if (words.some((word) => word.startsWith("~"))) return false;
  if (name === "find") return findAllowed(args, place);
  if (name === "git") {
    // git descends into submodules and runs their own config (core.fsmonitor): not a plain read there.
    if (hasSubmodules(place.root)) return false;
    let index = 0;
    while (args[index] === "--no-pager" || args[index] === "-P") index++;
    const sub = args[index];
    const spec = sub === undefined ? undefined : Object.hasOwn(GIT_READERS, sub) ? GIT_READERS[sub] : undefined;
    return Boolean(spec) && allowed(spec!, args.slice(index + 1), place, true);
  }
  const spec = Object.hasOwn(READERS, name) ? READERS[name] : undefined;
  return Boolean(spec) && allowed(spec!, args, place);
}

/** Outside quotes only these characters may appear: letters, digits, space, tab and the punctuation of paths, options and
 * the allowed operators. Anything else (a backslash, $, backtick, !, ( ) { } * ?, a control or non-ASCII character) means
 * the line is not read by this check. < and > are kept here only so a later check can see and refuse them. */
const SAFE_BARE = /^[A-Za-z0-9 \t._\-/:=@%+,|&;^~#<>]$/;
/** Inside double quotes the same, plus the characters of a search pattern and !, which is plain text in a script. Never $,
 * backtick, " (the quote tracker does not model an escaped quote), < or > or a non-ASCII one; a backslash only as a pair. */
const SAFE_QUOTED = /^[A-Za-z0-9 ._\-/:=@%+,|&;^~*?[\]{}()#'!]$/;
/** What may follow a backslash inside double quotes: bash keeps both as plain text unless the next one is $, backtick, " or
 * a backslash (or a newline), so any other printable ASCII character is fine. */
const QUOTED_BACKSLASH = /^[\x20-\x7e]$/;
/** Inside single quotes bash reads every character as plain text (a backslash, $, !, < >, backtick, * ? [ ] { } ( ) too), so any
 * printable ASCII one but the closing quote may be there. No tab, newline, CR, NUL, control or non-ASCII character. */
const SAFE_SINGLE = /^[\x20-\x26\x28-\x7e]$/;

/** The line itself when every character is in the safe set, else undefined. Done before any parsing, so a comment, a
 * backslash-newline, a CR, a no-break space and the like never reach the word splitter (which would read them differently
 * from bash). One trailing newline is just the end of the line. */
function safeLine(command: string): string | undefined {
  const text = command.endsWith("\n") ? command.slice(0, -1) : command;
  let quote: string | undefined;
  let wordStart = true;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quote) {
      if (char === quote) { quote = undefined; wordStart = false; continue; }
      if (quote === "\"" && char === "\\") {
        const next = text[index + 1];
        if (next === undefined || !QUOTED_BACKSLASH.test(next) || "$`\"\\".includes(next)) return undefined;
        index++;
        continue;
      }
      if (!(quote === "'" ? SAFE_SINGLE : SAFE_QUOTED).test(char)) return undefined;
      continue;
    }
    if (char === "'" || char === "\"") { quote = char; wordStart = false; continue; }
    if (!SAFE_BARE.test(char)) return undefined;
    // A # that starts a word begins a comment, which hides what follows from this check but not from bash.
    if (char === "#" && wordStart) return undefined;
    // ~ is only safe inside a word: bash expands it at a word start or after = or : .
    if (char === "~" && (wordStart || text[index - 1] === "=" || text[index - 1] === ":")) return undefined;
    wordStart = " \t|&;".includes(char);
  }
  return quote ? undefined : text;
}

/** The line with the contents of every quoted string replaced by x (same length, quotes kept), so a check for an operator
 * or a redirect sees only what bash reads as one. Run on a line safeLine has passed, whose quotes are balanced. */
function maskQuoted(text: string): string {
  let quote: string | undefined;
  let out = "";
  for (const char of text) {
    if (quote) { if (char === quote) { quote = undefined; out += char; } else out += "x"; continue; }
    if (char === "'" || char === "\"") quote = char;
    out += char;
  }
  return out;
}

/** A redirect that only discards or merges output (never &>, which dash, ash and ksh read as "run in the background"), as its own word followed by a space, the end or one of ; | &&. */
const HARMLESS_REDIRECT = /(?<=^|[ \t])(?:[12]?>\/dev\/null|2>&1)(?=$|[ \t;|]|&&)/g;

/** The line with those redirects (2>/dev/null, 2>&1, >/dev/null, 1>/dev/null) blanked out. Outside quotes only: the match
 * is made on the masked line, and the same places are blanked in the real one. */
function withoutHarmlessRedirects(text: string): string {
  const masked = maskQuoted(text);
  let out = "";
  let last = 0;
  for (const match of masked.matchAll(HARMLESS_REDIRECT)) {
    out += text.slice(last, match.index) + " ".repeat(match[0].length);
    last = match.index + match[0].length;
  }
  return out + text.slice(last);
}

/** True when every command on the line only reads files in the project: no redirect, no substitution, no
 * background job, no glob, no option it doesn't know, nothing outside the project or private. Pipes and && between
 * readers are fine. `where`: the project folder, or the project, your home and the private places. */
export function readOnlyCommand(command: string, where?: ReadPlace | string): boolean {
  const safe = safeLine(command);
  if (safe === undefined) return false;
  const text = withoutHarmlessRedirects(safe).trim();
  if (!text || /[<>`]|\$\(|(?:^|[^&])&(?!&)/.test(maskQuoted(text)) || hasGlob(text)) return false;
  const line = splitShell(text);
  if (!line.segments.length) return false;
  const place = placeOf(where);
  return line.segments.every((segment) => readerSegment(segment.words, place));
}

/** The git folder a project belongs to, found the way git does: the nearest .git going up from the project (a folder,
 * a link to one, or a .git file that points to one). "unknown" when it can't be worked out: callers then ask. */
function gitDirOf(folder: string): string | undefined | "unknown" {
  for (let dir = folder; ; dir = path.dirname(dir)) {
    const dot = path.join(dir, ".git");
    try {
      if (statSync(dot).isDirectory()) return realpathSync(dot);
      const target = /^gitdir:\s*(.+)$/m.exec(readFileSync(dot, "utf8"))?.[1]?.trim();
      return target ? realpathSync(path.resolve(dir, target)) : "unknown";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "unknown";
    }
    if (dir === path.dirname(dir)) return undefined;
  }
}

/** True when an index entry has the gitlink mode (a submodule or nested repository). A version 4 index, or one that
 * can't be read, counts as holding one: asking costs less than guessing. */
function indexHasGitlink(file: string): boolean {
  let data: Buffer;
  try { data = readFileSync(file); } catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
  if (data.length < 12 || data.toString("latin1", 0, 4) !== "DIRC") return true;
  const version = data.readUInt32BE(4);
  if (version !== 2 && version !== 3) return true;
  const count = data.readUInt32BE(8);
  let at = 12;
  for (let entry = 0; entry < count; entry++) {
    if (at + 62 > data.length) return true;
    if ((data.readUInt32BE(at + 24) >> 12) === 0o16) return true;
    const flags = data.readUInt16BE(at + 60);
    let nameStart = at + 62;
    if (version === 3 && flags & 0x4000) nameStart += 2;
    let nameEnd = nameStart + (flags & 0xfff);
    if ((flags & 0xfff) === 0xfff) { nameEnd = data.indexOf(0, nameStart); if (nameEnd < 0) return true; }
    at += Math.ceil((nameEnd - at + 1) / 8) * 8;
  }
  // Extensions: a split index ("link") keeps its entries in a shared file, a sparse index ("sdir") folds them into trees.
  while (at + 8 <= data.length - 20) {
    const name = data.toString("latin1", at, at + 4);
    if (name === "link" || name === "sdir") return true;
    at += 8 + data.readUInt32BE(at + 4);
  }
  return false;
}

/** True when the project's git repository has submodules or gitlinks: a .gitmodules file in the project or any folder
 * above it, a .git/modules folder (also the main repository's, for a worktree), or a gitlink in the index. */
function hasSubmodules(root: string): boolean {
  for (let folder = root; ; folder = path.dirname(folder)) {
    try { lstatSync(path.join(folder, ".gitmodules")); return true; } catch { /* none here */ }
    if (folder === path.dirname(folder)) break;
  }
  const gitDir = gitDirOf(root);
  if (gitDir === undefined) return false;
  if (gitDir === "unknown") return true;
  const common = path.basename(path.dirname(gitDir)) === "worktrees" ? path.resolve(gitDir, "..", "..") : gitDir;
  for (const dir of new Set([gitDir, common])) {
    try { if (lstatSync(path.join(dir, "modules")).isDirectory()) return true; } catch { /* none */ }
    try { if (readdirSync(dir).some((name) => name.startsWith("sharedindex."))) return true; } catch { return true; }
  }
  return indexHasGitlink(path.join(gitDir, "index"));
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
  "rundll32", "start", "command", "busybox", "stdbuf", "setsid", "caffeinate", "ionice", "script", "su", "runuser", "pkexec", "pypy", "luajit",
  "tmux", "screen", "crontab", "at", "batch"]);
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

/** True when `command` is one plain command starting with the prefix's words, each the same word. Only the program
 * name is relaxed, and only on Windows: npm.cmd and NPM.EXE are npm (a name with a folder never is). A line with any
 * space other than a plain space or tab (a no-break space, a form feed) never matches: the shell reads those as part of
 * a word, so they are a different command from the one that was approved. */
export function matchesPrefix(command: string, prefix: string, windows = process.platform === "win32"): boolean {
  // The line as typed: trim() would strip a leading or trailing no-break space and hide the very thing this looks for.
  if (/[^\S \t]/.test(command)) return false;
  const line = splitShell(command.trim());
  if (!line.simple) return false;
  const words = line.segments[0]?.words ?? [];
  // The folder test looks at the program word as typed: after splitting, a backslash is gone (`\npm.cmd` becomes `npm.cmd`).
  const typedTool = command.trimStart().split(/[ \t]/)[0] ?? "";
  // ASCII letters only: toLowerCase also turns the Kelvin sign (U+212A) into "k", which Windows file names do not do.
  // An ending is dropped only when something is left (".cmd" alone stays ".cmd").
  const tool = (word: string) => {
    if (!windows || /[\\/]/.test(typedTool) || /[\\/]/.test(word)) return word;
    const lower = word.replace(/[A-Z]/g, (char) => char.toLowerCase());
    return lower.replace(/(?<=.)\.(?:exe|cmd|bat|com|ps1)$/, "");
  };
  return prefix.split(" ").every((word, index) => {
    const have = words[index];
    return have !== undefined && (index === 0 ? tool(have) === tool(word) : have === word);
  });
}
