import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { isOutside } from "../platform/inside";
import { realpathLongest } from "../platform/project-paths";
import { lineCommands, readOnlyCommand, type ReadPlace } from "./read-only";

/**
 * With no sandbox, routine work runs without the "Run this command?" box, as Claude Code's auto mode does: git's everyday
 * commands and a push to a remote the project already has (no force, no deleting), gh's look-and-open commands, installs
 * from the project's own files, the builds, tests, linters and formatters the project defines, and making, copying, moving
 * or removing files in the project. A line is routine only when every command on it is a plain read or routine. Anything
 * else asks as before: sudo, a download run through a shell, a force push or a deleted remote branch, rm of the project,
 * its .git or anything outside it, a named new package, and every program not listed. A text check and an allow-list,
 * like read-only.ts (whose line reading it shares: no $, ~, redirect, substitution or subshell).
 */

interface Here { root: string; realRoot: string; cwd: string; where: ReadPlace }

/** True when every command on the line is a plain read or routine work (see above). */
export function routineCommand(command: string, where: ReadPlace | string): boolean {
  const line = lineCommands(command, where);
  if (!line) return false;
  const place: ReadPlace = typeof where === "string" ? { root: where } : where;
  return line.commands.every((part) => part.reads || (!part.globs && part.folders.every((cwd) =>
    routinePart(part.words, { root: line.root, realRoot: line.realRoot, cwd, where: place }))));
}

function routinePart(words: readonly string[], here: Here): boolean {
  const [name, ...args] = words;
  if (!name || name.includes("=")) return false;
  if (Object.hasOwn(FILE_OPTIONS, name)) return fileWork(name, args, here);
  if (!argsInside(args, here)) return false;
  if (name === "git") return gitWork(args, here);
  if (name === "gh") return ghWork(args, here);
  return installs(name, args, here) || builds(name, args, here);
}

/** Option values that are plain text (a commit message, a PR title), never a path to check. */
const TEXT_OPTIONS = new Set(["-m", "--message", "-t", "--title", "-b", "--body", "--notes"]);

/** A word that names a place by itself (a full path, or one with ..) must be in the project, as must an option's value
 * given with = (--outDir=/tmp/x) or stuck to a one-letter option (-C/x, -o../x). Text given to -m or --title is not a path. */
function argsInside(args: readonly string[], here: Here): boolean {
  return args.every((word, at) => {
    if (TEXT_OPTIONS.has(args[at - 1] ?? "") || TEXT_OPTIONS.has(word.slice(0, 2))
      || [...TEXT_OPTIONS].some((option) => option.startsWith("--") && word.startsWith(`${option}=`))) return true;
    const values = [word];
    if (word.startsWith("-") && word.includes("=")) values.push(word.slice(word.indexOf("=") + 1));
    if (/^-[A-Za-z]./.test(word)) values.push(word.slice(2));
    return values.every((value) => {
      if (value.includes("\\")) return false;
      const named = value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.split("/").includes("..");
      return !named || inside(value, here) !== undefined;
    });
  });
}

/** The place a word names, relative to the project (links resolved), or undefined when it is outside it. */
function inside(word: string, here: Here): string | undefined {
  if (word.includes("\\")) return undefined;
  const absolute = path.resolve(here.cwd, word);
  const relative = path.relative(here.root, absolute);
  const real = path.relative(here.realRoot, realpathLongest(absolute));
  return isOutside(relative) || isOutside(real) ? undefined : real;
}

/** A file the command reads and sends on (a PR body, a requirements list, what cp copies): one a plain `cat` could read
 * (in the project, not private). `tree`: it takes a whole folder, so a private file inside counts too, as for grep -r. */
function readable(file: string, here: Here, tree = false): boolean {
  // Forward slashes: a Windows path (src\a.ts) is a word the read check refuses.
  const relative = inside(file, here) === undefined ? undefined : path.relative(here.root, path.resolve(here.cwd, file)).split(path.sep).join("/");
  return relative !== undefined && !relative.includes("'") && !relative.startsWith("-")
    && readOnlyCommand(`${tree ? "grep -r x" : "cat"} '${relative || "."}'`, here.where);
}

/** True when one of `denied` is given as the program reads it: a long option shortened to its start (git and npm take
 * --forc for --force, --exe=x for --exec=x), a one-letter one in a group or with its value stuck on (-fd, -xmake). */
function hasOption(words: readonly string[], denied: readonly string[]): boolean {
  return words.some((word) => {
    if (word.startsWith("--")) {
      const name = word.split("=")[0]!;
      return name.length > 2 && denied.some((entry) => entry.startsWith("--") && entry.startsWith(name));
    }
    return word.startsWith("-") && denied.some((entry) => /^-[A-Za-z]$/.test(entry) && new RegExp(`^-[A-Za-z]*${entry[1]}`).test(word));
  });
}

/** The values given to options that name a file (-F x, -Fx, -aFx, --file x, --file=x, and --fil=x when the program takes
 * a shortened long option); undefined for one with no value. `letters`: the one-letter forms. */
function fileValues(words: readonly string[], letters: string, longs: readonly string[], shortened: boolean): Array<string | undefined> {
  const values: Array<string | undefined> = [];
  for (const [at, word] of words.entries()) {
    if (word === "--") break;
    if (word.startsWith("--")) {
      const [name = "", ...value] = word.split("=");
      if (longs.some((long) => long === name || (shortened && name.length > 2 && long.startsWith(name)))) values.push(value.length ? value.join("=") : words[at + 1]);
    } else if (word.startsWith("-")) {
      const match = new RegExp(`^-[A-Za-z]*?[${letters}](.*)$`).exec(word);
      if (match) values.push(match[1] || words[at + 1]);
    }
  }
  return values;
}

/** Every file an option names is one a plain read could print ("-" is the input). */
const filesReadable = (values: Array<string | undefined>, here: Here) => values.every((file) => file === "-" || (file !== undefined && readable(file, here)));

/** Short options may be grouped (-rf): each letter is checked. */
function letters(word: string): string[] {
  return /^-[A-Za-z]{2,}$/.test(word) ? [...word.slice(1)].map((letter) => `-${letter}`) : [word];
}

/** mkdir, touch, cp, mv and rm: the options each may have. */
const FILE_OPTIONS: Record<string, readonly string[]> = {
  mkdir: ["-p", "-v", "--parents", "--verbose"],
  touch: ["-c", "--no-create"],
  cp: ["-r", "-R", "-a", "-p", "-f", "-n", "-v", "-i", "--recursive", "--archive", "--force", "--no-clobber", "--verbose"],
  mv: ["-f", "-n", "-v", "-i", "--force", "--no-clobber", "--verbose"],
  rm: ["-r", "-R", "-f", "-d", "-v", "-i", "--recursive", "--force", "--dir", "--verbose"],
};

/** Every file named is in the project (links resolved), not private and not in a .git folder (what cp and mv take may not
 * hold a private file either); rm and mv never name the project itself. */
function fileWork(name: string, args: readonly string[], here: Here): boolean {
  const dash = args.indexOf("--");
  const options = dash < 0 ? args.filter((word) => word.startsWith("-")) : args.slice(0, dash).filter((word) => word.startsWith("-"));
  const files = dash < 0 ? args.filter((word) => !word.startsWith("-")) : [...args.slice(0, dash).filter((word) => !word.startsWith("-")), ...args.slice(dash + 1)];
  if (!options.flatMap(letters).every((option) => FILE_OPTIONS[name]!.includes(option))) return false;
  if (files.length < (name === "cp" || name === "mv" ? 2 : 1)) return false;
  return files.every((file, at) => {
    const relative = inside(file, here);
    if (relative === undefined || relative.split(path.sep).some((part) => part.toLowerCase() === ".git")) return false;
    if (!readable(file, here, (name === "cp" || name === "mv") && at < files.length - 1)) return false;
    // What rm removes and what mv moves away; mv's last word is where it goes and may be the project.
    return relative !== "" || name === "mkdir" || name === "touch" || name === "cp" || (name === "mv" && at === files.length - 1);
  });
}

/** Options that run a program of their own choosing, on any git command (git takes them shortened, --upload-pa=x). */
const GIT_RUNS = ["--upload-pack", "--receive-pack", "--exec"];
/** A branch name: a plain word, never a path or pathspec magic (:/, :(top)src), which restores files from the index. */
const BRANCH = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;

function gitWork(args: readonly string[], here: Here): boolean {
  const [sub, ...rest] = args;
  if (hasOption(rest, GIT_RUNS)) return false;
  const options = rest.filter((word) => word.startsWith("-")).flatMap(letters);
  const words = rest.filter((word) => !word.startsWith("-"));
  const none = (denied: readonly string[]) => !hasOption(rest, denied);
  // A message file (-F, --template) is sent on with the commit: one a plain read could print.
  const messages = (more: string, longs: readonly string[]) => filesReadable(fileValues(rest, `F${more}`, ["--file", ...longs], true), here);
  switch (sub) {
    case "add":
      return none(["-f", "--force"]) && words.every((word) => readable(word, here));
    case "commit":
      return messages("t", ["--template"]);
    case "merge":
      return messages("", []);
    case "restore":
      return (options.includes("--staged") || options.includes("-S")) && none(["-W", "--worktree"]);
    case "switch":
      return none(["-f", "--force", "--discard-changes", "-C", "--force-create", "-m", "--merge"]) && words.length <= 2;
    case "checkout": {
      if (rest.includes("--") || !none(["-f", "--force", "-B", "-p", "--patch", "--ours", "--theirs", "-m", "--merge"])) return false;
      if (options.includes("-b")) return words.length >= 1 && words.length <= 2;
      // `git checkout file` throws away its changes: only a name that is not a file here is a branch.
      return words.length === 1 && options.length === 0 && BRANCH.test(words[0]!) && !words[0]!.split("/").includes("..")
        && !exists(path.resolve(here.cwd, words[0]!));
    }
    case "branch":
      return options.every((option) => ["-a", "-r", "-l", "-v", "--list", "--all", "--remotes", "--show-current", "--verbose"].includes(option)) && words.length <= 2;
    case "fetch": case "pull":
      // No force: a +refspec, --force or --refmap rewrites local branches (and pull merges on top).
      if (!none(["-f", "--force", "--refmap"])) return false;
      return words.length === 0 || (remotes(here.root).includes(words[0]!) && words.slice(1).every(plainRef));
    case "rebase":
      return none(["-x", "--exec", "-i", "--interactive"]);
    case "tag":
      return none(["-d", "--delete", "-f", "--force"]) && messages("", []);
    case "stash":
      return rest.length === 0 || rest[0]!.startsWith("-") || ["push", "pop", "apply", "list", "show"].includes(rest[0]!);
    case "worktree":
      return rest[0] === "list" || (rest[0] === "add" && !hasOption(rest.slice(1), ["-f", "--force", "-B"]));
    case "push":
      return pushWork(rest, here);
    default:
      return false;
  }
}

const PUSH_OPTIONS = ["-u", "-v", "-q", "-n", "--set-upstream", "--tags", "--follow-tags", "--verbose", "--quiet", "--dry-run", "--porcelain", "--atomic", "--no-verify"];
/** A branch or tag to push, or src:dst; never :dst (deletes it) or +src (forces it). */
const REFSPEC = /^[A-Za-z0-9._/-]+(?::[A-Za-z0-9._/-]+)?$/;

/** A push to a remote the project already has, with no force, mirror or delete. */
function pushWork(rest: readonly string[], here: Here): boolean {
  if (!rest.filter((word) => word.startsWith("-")).flatMap(letters).every((option) => PUSH_OPTIONS.includes(option))) return false;
  const [remote, ...refs] = rest.filter((word) => !word.startsWith("-"));
  if (remote === undefined) return true;
  return remotes(here.root).includes(remote) && refs.every(plainRef);
}

const plainRef = (ref: string) => REFSPEC.test(ref) && !ref.split(/[/:]/).includes("..");

const exists = (place: string) => { try { lstatSync(place); return true; } catch { return false; } };

/** The remotes in the project's git config (a worktree's too, through its common folder). [include] files are not read. */
export function remotes(root: string): string[] {
  for (let dir = root; ; dir = path.dirname(dir)) {
    const dot = path.join(dir, ".git");
    try {
      let gitDir = dot;
      if (!statSync(dot).isDirectory()) {
        const target = /^gitdir:\s*(.+)$/m.exec(readFileSync(dot, "utf8"))?.[1]?.trim();
        if (!target) return [];
        gitDir = path.resolve(dir, target);
      }
      const common = path.join(gitDir, "commondir");
      if (existsSync(common)) gitDir = path.resolve(gitDir, readFileSync(common, "utf8").trim());
      const config = readFileSync(path.join(gitDir, "config"), "utf8");
      return [...config.matchAll(/^\s*\[remote\s+"([^"\n]+)"\]/gm)].map((match) => match[1]!);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return [];
    }
    if (dir === path.dirname(dir)) return [];
  }
}

/** gh commands that look, open a pull request or issue, or comment on one. */
const GH_ROUTINE = new Set(["pr create", "pr view", "pr list", "pr checks", "pr diff", "pr checkout", "pr status", "issue create", "issue view",
  "issue list", "issue comment", "run view", "run list", "run watch", "repo view"]);
const GH_FILES = ["--body-file", "--template", "--input"];
const GH_FIELDS = ["-f", "-F", "--field", "--raw-field", "--input"];

function ghWork(args: readonly string[], here: Here): boolean {
  // A file it sends (a PR body, a template) is one a plain read could print: in the project and not private.
  if (args[0] !== "api" && !filesReadable(fileValues(args, "FT", GH_FILES, false), here)) return false;
  if (args[0] !== "api") return GH_ROUTINE.has(`${args[0]} ${args[1]}`);
  // gh api: GET only. It sends a POST when given fields, unless told GET.
  let method: string | undefined;
  for (const [at, word] of args.entries()) {
    if (word === "-X" || word === "--method") method = args[at + 1];
    else if (word.startsWith("--method=")) method = word.slice("--method=".length);
    else if (/^-X./.test(word)) method = word.slice(2);
  }
  if (args.includes("graphql")) return false;
  const fields = args.some((word) => GH_FIELDS.some((entry) => word === entry || word.startsWith(`${entry}=`)));
  return method === undefined ? !fields : method.toUpperCase() === "GET" && !args.includes("--input");
}

/** Options that send an install somewhere else (global, another folder or registry): those ask. */
const ELSEWHERE = new Set(["-g", "--global", "--location", "--prefix", "--registry", "-C", "--cwd", "--dir", "--userconfig", "--globalconfig",
  "--script-shell", "--modules-folder", "--cache", "--target", "--user", "--root", "--system"]);
/** Only plain options with no value: a word that is not an option would be a package to add. npm takes a long option
 * shortened (--glob is --global), so the start of one that sends it elsewhere asks too. */
const flagsOnly = (args: readonly string[]) => args.every((word) => /^--?[A-Za-z][\w-]*$/.test(word) && !ELSEWHERE.has(word)
  && !(word.startsWith("--") && [...ELSEWHERE].some((option) => option.startsWith(word))));

/** Installs from the project's own files: no package named. */
function installs(name: string, args: readonly string[], here: Here): boolean {
  const [sub, ...rest] = args;
  if (name === "npm") return (sub === "ci" || sub === "install" || sub === "i") && flagsOnly(rest);
  if (name === "pnpm" || name === "bun") return (sub === "install" || sub === "i") && flagsOnly(rest);
  if (name === "yarn") return sub === undefined || (sub === "install" && flagsOnly(rest));
  if (name === "pip" || name === "pip3") return sub === "install" && pipFromFiles(rest, here);
  if (name === "uv") return sub === "sync" && flagsOnly(rest);
  if (name === "poetry" || name === "bundle") return sub === "install" && flagsOnly(rest);
  if (name === "go" && sub === "mod") return rest[0] === "download" && flagsOnly(rest.slice(1));
  if (name === "cargo") return sub === "fetch" && flagsOnly(rest);
  return false;
}

/** pip install -r <file in the project> or -e . (and -q, -U). */
function pipFromFiles(args: readonly string[], here: Here): boolean {
  let any = false;
  for (let at = 0; at < args.length; at++) {
    const word = args[at]!;
    if (["-q", "--quiet", "-U", "--upgrade"].includes(word)) continue;
    if ((word === "-r" || word === "--requirement") && args[at + 1] !== undefined && readable(args[at + 1]!, here)) { at++; any = true; continue; }
    if (word === "-e" && args[at + 1] === ".") { at++; any = true; continue; }
    return false;
  }
  return any;
}

/** Linters, formatters and test runners that are routine whatever their options. */
const TOOLS = new Set(["tsc", "eslint", "prettier", "oxlint", "pytest"]);
const SUBS: Record<string, readonly string[]> = { go: ["build", "test", "vet"], cargo: ["build", "test", "check", "clippy", "fmt"], dotnet: ["build", "test"] };
/** go's flags with no way to run a program (-exec, -toolexec, -vettool and -ldflags ask). */
const GO_FLAGS = new Set(["v", "race", "count", "run", "skip", "short", "cover", "coverprofile", "covermode", "coverpkg", "timeout", "tags",
  "o", "bench", "benchmem", "benchtime", "failfast", "json", "p", "parallel", "cpu", "mod", "trimpath", "a", "n", "x", "shuffle"]);
/** Maven goals and Gradle tasks, and their plain flags: no plugin goal (exec:exec) and no -D but skipping tests. */
const GOALS: Record<string, { words: readonly string[]; flags: RegExp }> = {
  mvn: { words: ["clean", "compile", "test", "package", "verify"], flags: /^(?:-q|-B|-o|-U|-e|--quiet|--batch-mode|--offline|-DskipTests(?:=true)?|-Dmaven\.test\.skip=true)$/ },
  gradle: { words: ["build", "test", "check", "clean", "assemble"], flags: /^(?:-q|--quiet|--offline|--info|--stacktrace|--no-daemon|--parallel|--console=plain)$/ },
};
/** Installed programs that run any code given to them (an interpreter, or one that runs another command). */
const RUNNERS = new Set(["node", "tsx", "ts-node", "cross-env", "concurrently", "npm-run-all", "run-s", "run-p", "zx", "vite-node", "esno", "shx",
  "execa", "nodemon", "bash", "sh"]);

/** The project's own builds, tests, linters and formatters. */
function builds(name: string, args: readonly string[], here: Here): boolean {
  const [sub, ...rest] = args;
  if (TOOLS.has(name)) return true;
  // make: targets and plain flags; a variable (CC=x), --eval or -f/-C would run what it is told.
  if (name === "make") return args.every((word) => /^-(?:j\d*|[ksnBw]+)$/.test(word) || /^[A-Za-z0-9_][\w.-]*$/.test(word));
  if (["python", "python3", "py"].includes(name)) return sub === "-m" && (rest[0] === "pytest" || rest[0] === "unittest");
  const gradle = name === "./gradlew" || name === "gradlew" ? "gradle" : name;
  if (Object.hasOwn(GOALS, gradle)) return args.some((word) => GOALS[gradle]!.words.includes(word))
    && args.every((word) => GOALS[gradle]!.words.includes(word) || GOALS[gradle]!.flags.test(word));
  if (Object.hasOwn(SUBS, name)) {
    if (sub === undefined || !SUBS[name]!.includes(sub)) return false;
    if (name === "go") return rest.every((word) => !word.startsWith("-") || GO_FLAGS.has(word.replace(/^--?/, "").split("=")[0]!));
    if (name === "cargo") return !hasOption(rest, ["--config", "-Z"]);
    return !rest.some((word) => /^(?:-p:|-p$|--property|-property:)/i.test(word));
  }
  if (["npm", "pnpm", "yarn", "bun"].includes(name)) {
    if (sub === "test" || (name === "npm" && sub === "t")) return true;
    if (sub === "run" || (name === "npm" && sub === "run-script")) return rest[0] !== undefined && scripts(here).includes(rest[0]);
    if (name === "pnpm" && sub === "exec") return runs(rest, here);
    return false;
  }
  if (name === "npx" || name === "bunx") return runs(args, here);
  return false;
}

/** An installed program that is not an interpreter or command runner, given no code to run (-e, --eval, --print). */
function runs([bin, ...rest]: readonly string[], here: Here): boolean {
  return bin !== undefined && installed(bin, here) && !RUNNERS.has(bin) && !rest.some((word) => /^(?:-e|--eval|--print)(?:=|$)/.test(word));
}

/** The scripts in the nearest package.json, from the folder the command runs in up to the project. */
function scripts(here: Here): string[] {
  for (let dir = here.cwd; ; dir = path.dirname(dir)) {
    try {
      const file = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
      return file.scripts && typeof file.scripts === "object" ? Object.keys(file.scripts) : [];
    } catch { /* none here */ }
    if (isOutside(path.relative(here.root, path.dirname(dir))) || dir === path.dirname(dir)) return [];
  }
}

/** A program the project installed: node_modules/.bin/<name>, from the folder the command runs in up to the project. */
function installed(name: string, here: Here): boolean {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith(".")) return false;
  for (let dir = here.cwd; ; dir = path.dirname(dir)) {
    if (exists(path.join(dir, "node_modules", ".bin", name))) return true;
    if (isOutside(path.relative(here.root, path.dirname(dir))) || dir === path.dirname(dir)) return false;
  }
}
