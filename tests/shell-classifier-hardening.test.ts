import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readOnlyCommand } from "../src/sandbox/read-only";
import { removeTempDir } from "./support/temp-dir";

/**
 * The plain-read check is a strict set of safe characters, not a model of the shell: a line with a comment, a
 * backslash, a newline, an exotic character, a ".." after a link, or a git repository with submodules is not a read.
 * Each case below is proven dangerous in real bash first (POSIX only), then refused by readOnlyCommand.
 */

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => removeTempDir(root))); });

const posix = process.platform !== "win32";
const GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };

async function area() {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-classifier-")));
  roots.push(base);
  const home = path.join(base, "home"), project = path.join(base, "project"), outside = path.join(base, "outside");
  for (const dir of [home, project, outside, path.join(home, ".ssh")]) await mkdir(dir, { recursive: true });
  await writeFile(path.join(project, "README.md"), "readme");
  await writeFile(path.join(home, "notes.txt"), "OUTSIDE-NOTES");
  await writeFile(path.join(home, "secret.txt"), "OUTSIDE-SECRET");
  await writeFile(path.join(home, ".ssh", "id_rsa"), "OUTSIDE-KEY");
  await writeFile(path.join(base, "s.txt"), "OUTSIDE-S");
  await writeFile(path.join(outside, "s.txt"), "OUTSIDE-O");
  return { base, home, project, outside, where: { root: project, home, denyRead: [] as string[] } };
}

function bash(line: string, cwd: string, home: string) {
  const run = spawnSync("bash", ["-c", line], { cwd, encoding: "utf8", env: { PATH: process.env.PATH, HOME: home, ...GIT_ENV } });
  return `${run.stdout}${run.stderr}`;
}

test("a comment cannot hide the lines after it", async () => {
  const { project, home, where } = await area();
  const markers: Array<[string, string]> = [
    ["cat README.md # '\ntouch MARK\necho '", "MARK"],
    ["cat README.md # \"\ntouch MARK\necho \"", "MARK"],
    ["echo hi # \\\n touch MARK", "MARK"],
    ["ls # '\ntouch X", "X"],
    ["git status #'\ntouch X\n'", "X"],
  ];
  for (const [line, marker] of markers) {
    expect({ line, read: readOnlyCommand(line, where) }).toEqual({ line, read: false });
    if (posix) {
      bash(line, project, home);
      expect({ line, ran: existsSync(path.join(project, marker)) }).toEqual({ line, ran: true });
      await removeTempDir(path.join(project, marker));
    }
  }
  expect(readOnlyCommand("printf -v CDPATH '%s' x # '\ncd ~/.ssh\ncat id_rsa\necho '", where)).toBe(false);
  // A # inside a word or a quote is not a comment.
  expect(readOnlyCommand("grep -n 'a#b' README.md", where)).toBe(true);
  expect(readOnlyCommand("cat a#b", where)).toBe(true);
  expect(readOnlyCommand("cat README.md #", where)).toBe(false);
  expect(readOnlyCommand("cat README.md ;#x", where)).toBe(false);
});

test(".. after a link is not read-only: the kernel follows the link first, the text check does not", async () => {
  const { project, home, where } = await area();
  await symlink(path.join(home, ".ssh"), path.join(project, "sshl"));
  await symlink(home, path.join(project, "homelink"));
  await symlink("../outside", path.join(project, "out"));
  await symlink(".", path.join(project, "self"));
  const lines = ["cat sshl/../notes.txt", "cat homelink/../secret.txt", "ls sshl/..", "grep -r KEY sshl/..", "find sshl/.. -name id_rsa",
    "cat out/../s.txt", "cat self/../s.txt", "cat ./out/./../s.txt", "cd self/../outside && cat s.txt"];
  for (const line of lines) {
    expect({ line, read: readOnlyCommand(line, where) }).toEqual({ line, read: false });
    if (posix) expect({ line, out: bash(line, project, home) }).toEqual({ line, out: expect.stringMatching(/OUTSIDE|id_rsa|notes\.txt|secret\.txt|s\.txt/) });
  }
  // Even without a link, a .. after a name asks; leading ../ steps are left to the project check; no .. at all is fine.
  expect(readOnlyCommand("cat src/../README.md", where)).toBe(false);
  expect(readOnlyCommand("git show HEAD:src/../README.md", where)).toBe(false);
  expect(readOnlyCommand("cat ../project/README.md", where)).toBe(true);
  expect(readOnlyCommand("cat ../README.md", where)).toBe(false);
  expect(readOnlyCommand("cat ./README.md", where)).toBe(true);
  expect(readOnlyCommand("ls ..", where)).toBe(false);
});

test("a backslash-newline joins words, so a line with a backslash or a newline is not read-only", async () => {
  const { project, home, where } = await area();
  await writeFile(path.join(project, "x2"), "JOINED");
  for (const line of ["cat x\\\n2>&1", "cat 'x'\\\n2>&1"]) {
    expect({ line, read: readOnlyCommand(line, where) }).toEqual({ line, read: false });
    if (posix) expect({ line, out: bash(line, project, home) }).toEqual({ line, out: expect.stringContaining("JOINED") });
  }
  for (const line of ["cat a\\ b", "grep a\\.b README.md","ls\ncat README.md", "ls\n\ncat README.md", "cat README.md\r\nls", "ls\ncat README.md\n"]) {
    expect({ line, read: readOnlyCommand(line, where) }).toEqual({ line, read: false });
  }
  // One trailing newline is just the end of the line.
  expect(readOnlyCommand("cat README.md\n", where)).toBe(true);
});

test("a carriage return, no-break space or form feed inside a word is part of the file name, not a separator", async () => {
  const { project, home, where } = await area();
  const files: Array<[string, string]> = [["x\r", "CR-FILE"], ["x y", "NBSP-FILE"], ["y\fz", "FF-FILE"]];
  // Windows cannot have a file name with a carriage return or form feed, so the files only exist (and bash only runs) on POSIX.
  if (posix) for (const [name, content] of files) await writeFile(path.join(project, name), content);
  for (const [line, content] of [["cat x\r", "CR-FILE"], ["cat x y", "NBSP-FILE"], ["cat y\fz", "FF-FILE"]] as const) {
    expect({ line, read: readOnlyCommand(line, where) }).toEqual({ line, read: false });
    if (posix) expect({ line, out: bash(line, project, home) }).toEqual({ line, out: expect.stringContaining(content) });
  }
  for (const line of ["cat x\r", "cat  README.md", "cat README.md\f", "  cat README.md", "cat 'é'", "cat 'a\u0001b'", "cat a\u0000b", "cat \u007fx"]) {
    expect({ line, read: readOnlyCommand(line, where) }).toEqual({ line, read: false });
  }
  expect(readOnlyCommand("  \tcat README.md \t", where)).toBe(true);
});

test("characters outside the safe set ask: $, backtick, !, ~ at a word start, braces, parentheses, unclosed quotes", async () => {
  const { where } = await area();
  for (const line of ["cat $HOME/x", "cat \"$HOME/x\"", "cat ~/x", "cat a=~/x", "cat a:~/x", "echo (x)", "echo {a,b}", "echo 'a",
    "echo \"a", "echo 'it'\"s", "cat a*", "echo \"`id`\""]) {
    expect({ line, read: readOnlyCommand(line, where) }).toEqual({ line, read: false });
  }
  // The look-around commands people actually run keep working.
  for (const line of ["ls -la src", "cat README.md", "git show HEAD~1 --stat", "git show HEAD^", "grep -rn 'foo bar' .", "rg -n --hidden -g '*.ts' foo",
    "head -n 20 README.md | grep -n \"a.*b\"", "find . -name '*.ts' -type f", "git log --oneline -5; echo \"---\"; cat README.md", "date +%F", "git log --format='%h %s' -5",
    "git diff main..feature --stat", "git show HEAD~1", "git diff @{1}"]) {
    if (line === "git diff @{1}") { expect(readOnlyCommand(line, where)).toBe(false); continue; }
    expect({ line, read: readOnlyCommand(line, where) }).toEqual({ line, read: true });
  }
});

test("the common multi-command look-around lines still run without asking (the cd and 2>/dev/null parts land with another change)", async () => {
  const { project, home } = await area();
  await mkdir(path.join(project, "src")); await mkdir(path.join(project, "tests"));
  const line = "find src tests -type f | head -50; echo \"---README---\"; cat README.md";
  expect(readOnlyCommand(line, project)).toBe(true);
  expect(readOnlyCommand(line, { root: project, home, denyRead: [] })).toBe(true);
  expect(readOnlyCommand("git log --oneline -5; echo \"---\"; cat README.md | head -60", project)).toBe(true);
  expect(readOnlyCommand("cat .casper/project.yaml; echo \"---tests---\"; head -n 80 tests/test_app.py; echo \"===\"; head -n 80 tests/test_data.py", project)).toBe(true);
});

/** A repository with a nested repository registered in its index, whose own config runs a program when git looks at it. */
async function repoWithSubmodule(project: string, marker: string, withModulesFile: boolean) {
  const git = (cwd: string, ...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "protocol.file.allow=always", ...args],
    { cwd, encoding: "utf8", env: { PATH: process.env.PATH, HOME: project, ...GIT_ENV } });
  git(project, "init", "-q");
  await mkdir(path.join(project, "sub"));
  git(path.join(project, "sub"), "init", "-q");
  await writeFile(path.join(project, "sub", "a.txt"), "a");
  git(path.join(project, "sub"), "add", ".");
  git(path.join(project, "sub"), "commit", "-q", "-m", "one");
  git(path.join(project, "sub"), "config", "core.fsmonitor", `touch ${marker}; true`);
  if (withModulesFile) await writeFile(path.join(project, ".gitmodules"), "[submodule \"sub\"]\n\tpath = sub\n\turl = ./sub\n");
  git(project, "add", withModulesFile ? ".gitmodules" : ".");
  if (withModulesFile) git(project, "add", "sub");
  git(project, "commit", "-q", "-m", "outer");
}

test("git asks when the repository has a submodule or gitlink: git runs its config (core.fsmonitor)", async () => {
  const { base, home, project } = await area();
  const marker = path.join(base, "FSMONITOR-RAN");
  await repoWithSubmodule(project, marker, true);
  const where = { root: project, home, denyRead: [] as string[] };
  for (const line of ["git status", "git diff", "git diff --stat", "git status -uall", "git diff sub", "git log --oneline"]) {
    expect({ line, read: readOnlyCommand(line, where) }).toEqual({ line, read: false });
  }
  if (posix) {
    for (const line of ["git status", "git diff", "git diff --stat", "git status -uall", "git diff sub"]) {
      bash(line, project, home);
      expect({ line, ran: existsSync(marker) }).toEqual({ line, ran: true });
      await removeTempDir(marker);
    }
  }
  // Non-git commands in the same project are not affected.
  expect(readOnlyCommand("cat README.md", where)).toBe(true);
});

test("git asks for a gitlink in the index even with no .gitmodules file", async () => {
  const { base, home, project } = await area();
  await repoWithSubmodule(project, path.join(base, "M"), false);
  expect(readOnlyCommand("git status", { root: project, home, denyRead: [] })).toBe(false);
  expect(readOnlyCommand("git diff sub", { root: project, home, denyRead: [] })).toBe(false);
});

test("git asks for a .gitmodules file in a folder above the project, or a .git/modules folder", async () => {
  const { base, home, project } = await area();
  const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8", env: { PATH: process.env.PATH, HOME: home, ...GIT_ENV } });
  git(project, "init", "-q");
  const where = { root: project, home, denyRead: [] as string[] };
  expect(readOnlyCommand("git status", where)).toBe(true);
  await mkdir(path.join(project, ".git", "modules"));
  expect(readOnlyCommand("git status", where)).toBe(false);
  await removeTempDir(path.join(project, ".git", "modules"));
  expect(readOnlyCommand("git status", where)).toBe(true);
  await writeFile(path.join(base, ".gitmodules"), "");
  expect(readOnlyCommand("git status", where)).toBe(false);
  expect(readOnlyCommand("cat README.md", where)).toBe(true);
});

/** A repository whose index holds a gitlink to a nested repository (no .gitmodules); `top` is the repo, the nested one is `top/<nested>`. */
async function repoWithNested(top: string, nested: string, marker: string) {
  const git = (cwd: string, ...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
    { cwd, encoding: "utf8", env: { PATH: process.env.PATH, HOME: top, ...GIT_ENV } });
  await mkdir(top, { recursive: true });
  git(top, "init", "-q");
  const inner = path.join(top, nested);
  await mkdir(inner, { recursive: true });
  git(inner, "init", "-q");
  await writeFile(path.join(inner, "a.txt"), "a");
  git(inner, "add", ".");
  git(inner, "commit", "-q", "-m", "one");
  git(inner, "config", "core.fsmonitor", `touch ${marker}; true`);
  git(top, "add", nested);
  git(top, "commit", "-q", "-m", "outer");
  return git;
}

test("git asks when the project is a subfolder of a repository that holds a gitlink (no .gitmodules)", async () => {
  const { base, home } = await area();
  const cases = [{ top: "outer", proj: "outer/proj", nested: "proj/inner" }, { top: "o2", proj: "o2/proj", nested: "lib/inner" }];
  for (const { top, proj, nested } of cases) {
    const marker = path.join(base, `M-${top}`);
    await repoWithNested(path.join(base, top), nested, marker);
    await mkdir(path.join(base, proj), { recursive: true });
    const where = { root: path.join(base, proj), home, denyRead: [] as string[] };
    for (const line of ["git status", "git diff", "git diff --stat", "git status -uall"]) {
      expect({ line, read: readOnlyCommand(line, where) }).toEqual({ line, read: false });
      if (posix) {
        bash(line, where.root, home);
        expect({ line, ran: existsSync(marker) }).toEqual({ line, ran: true });
        await removeTempDir(marker);
      }
    }
  }
});

test("git asks for a split index (the gitlink lives in sharedindex) and when .git is a link to the git folder", async () => {
  const { base, home } = await area();
  const marker = path.join(base, "M-split");
  const top = path.join(base, "split");
  const git = await repoWithNested(top, "proj/inner", marker);
  git(top, "update-index", "--split-index");
  const where = { root: top, home, denyRead: [] as string[] };
  expect(readOnlyCommand("git status", where)).toBe(false);
  expect(readOnlyCommand("git diff --stat", where)).toBe(false);
  if (posix) {
    bash("git status", top, home);
    expect(existsSync(marker)).toBe(true);
  }
  // .git as a link to the real git folder.
  const real = path.join(base, "linked-real");
  await repoWithNested(real, "inner", path.join(base, "M-link"));
  const proj = path.join(base, "linked");
  await mkdir(proj);
  await symlink(path.join(real, ".git"), path.join(proj, ".git"));
  expect(readOnlyCommand("git status", { root: proj, home, denyRead: [] })).toBe(false);
  // A plain repository still reads, also from a subfolder.
  const plain = path.join(base, "plain", "sub");
  await mkdir(plain, { recursive: true });
  git(path.join(base, "plain"), "init", "-q");
  expect(readOnlyCommand("git status", { root: plain, home, denyRead: [] })).toBe(true);
});


test("printf takes no options: -v assigns a variable the next command of the line then uses", async () => {
  const { project, home, where } = await area();
  await mkdir(path.join(project, "bin"));
  await writeFile(path.join(project, "bin", "ls"), "#!/bin/sh\necho SHIPPED-LS\n", { mode: 0o755 });
  for (const name of ["PATH", "IFS", "BASH_ENV", "PWD", "CDPATH", "HOME", "XDG_CONFIG_HOME"]) {
    const line = `printf -v ${name} bin; ls`;
    expect({ line, read: readOnlyCommand(line, where) }).toEqual({ line, read: false });
  }
  if (posix) expect(bash("printf -v PATH bin; ls", project, home)).toContain("SHIPPED-LS");
  // The format's %n assigns to a variable too (bash): found by probing, proven here.
  if (posix) expect(bash("printf '%n' X; echo \"[$X]\"", project, home)).toBe("[0]\n");
  for (const line of ["printf '%n' PATH; ls", "printf %n IFS", "printf '%5n' X", "printf '%ln' X", "printf '%-n' X", "printf '%*n' 1 X", "printf 'a%%%n' X", "printf '%hn' X"]) {
    expect({ line, read: readOnlyCommand(line, where) }).toEqual({ line, read: false });
  }
  for (const line of ["printf '%sn' x", "printf '%d\\n' 5", "printf '100%%\\n'", "printf '%s %s\\n' a b", "printf '%b' 'a\\n'"]) {
    expect({ line, read: readOnlyCommand(line, where) }).toEqual({ line, read: true });
  }
  for (const line of ["printf -vPATH bin", "printf -v", "printf --v x", "printf -z x", "printf '%s' x -v"]) {
    expect({ line, read: readOnlyCommand(line, where) }).toEqual({ line, read: false });
  }
  for (const line of ["printf hello", "printf '%s\\n' a b", "printf -- '%s' x", "printf -- -v x", "printf \"%s\" a | head -1"]) {
    expect({ line, read: readOnlyCommand(line, where) }).toEqual({ line, read: true });
  }
  // echo, true and false cannot assign anything: their options only change what is printed (or nothing).
  if (posix) {
    expect(bash("echo -v X Y; echo \"[$X]\"", project, home)).toBe("-v X Y\n[]\n");
    expect(bash("true -v X Y; false -v X Y; echo \"[$X]\"", project, home)).toBe("[]\n");
  }
  // A line whose first word is not a known reader never passes.
  for (const line of ["PATH=bin ls", "X=1", "export PATH=bin", "read PATH", "cd bin", "set -u", "unset PATH", "alias ls=x", "declare -x A=1", "mapfile A", "ls; export X=1",
    "cat README.md && PATH=bin ls", "printf -v PATH bin; ls", "local x"]) {
    expect({ line, read: readOnlyCommand(line, where) }).toEqual({ line, read: false });
  }
});

test("diff takes regular files only: a folder operand compares the files inside, and a link inside reaches outside", async () => {
  const { project, outside, home, where } = await area();
  await mkdir(path.join(project, "dirA")); await mkdir(path.join(project, "dirB"));
  await writeFile(path.join(outside, "secret.txt"), "OUTSIDE-DIFF-SECRET");
  await symlink(path.join(outside, "secret.txt"), path.join(project, "dirA", "x"));
  await symlink(path.join(outside, "secret.txt"), path.join(project, "dirA", "README.md"));
  await writeFile(path.join(project, "dirB", "x"), "inside");
  await writeFile(path.join(project, "a.txt"), "a\n"); await writeFile(path.join(project, "b.txt"), "b\n");
  const lines = ["diff dirA dirB", "diff -N dirA dirB", "diff -u dirA/ README.md", "diff -u dirA README.md", "diff --new-file dirA dirB", "diff -r dirA dirB",
    "diff --recursive dirA dirB", "diff -u a.txt ."];
  for (const line of lines) expect({ line, read: readOnlyCommand(line, where) }).toEqual({ line, read: false });
  if (posix) {
    for (const line of ["diff dirA dirB", "diff -N dirA dirB", "diff -u dirA/ README.md"]) {
      expect({ line, out: bash(line, project, home) }).toEqual({ line, out: expect.stringContaining("OUTSIDE-DIFF-SECRET") });
    }
  }
  expect(readOnlyCommand("diff a.txt b.txt", where)).toBe(true);
  // A file that is not there is only an error message from diff.
  expect(readOnlyCommand("diff a.txt missing.txt", where)).toBe(true);
  expect(readOnlyCommand("diff -u a.txt ./b.txt", where)).toBe(true);
  expect(readOnlyCommand("diff -u a.txt -", where)).toBe(true);
});

test("readers that walk folders do not follow a link inside the folder to somewhere outside", async () => {
  if (!posix) return;
  const { project, outside, home } = await area();
  await writeFile(path.join(outside, "leak.txt"), "OUTSIDE-LEAK-MARKER");
  await mkdir(path.join(project, "d"));
  await symlink(outside, path.join(project, "d", "out"));
  await symlink(path.join(outside, "leak.txt"), path.join(project, "d", "leak.txt"));
  const where = { root: project, home, denyRead: [] as string[] };
  // Folder walkers that print file contents: they must not open anything behind a link inside the folder.
  for (const line of ["grep -r OUTSIDE-LEAK-MARKER d", "grep -rn OUTSIDE-LEAK-MARKER .", "rg OUTSIDE-LEAK-MARKER d", "rg -n OUTSIDE-LEAK-MARKER .",
    "ls -R d", "du -a d", "tree d", "find d -name 'leak*' -type f", "grep -r --include='*.txt' OUTSIDE-LEAK-MARKER d"]) {
    // Real bash first: if a walker did print the outside file's text, the line must be refused instead.
    const out = bash(line, project, home);
    if (out.includes("OUTSIDE-LEAK-MARKER")) expect({ line, read: readOnlyCommand(line, where) }).toEqual({ line, read: false });
  }
  // Content readers never print a linked file's text when the walk is plain (grep -r, rg, find, ls -R, du do not follow links in folders).
  expect(bash("grep -r OUTSIDE-LEAK-MARKER d", project, home)).not.toContain("OUTSIDE-LEAK-MARKER");
  expect(bash("grep -rn OUTSIDE-LEAK-MARKER .", project, home)).not.toContain("OUTSIDE-LEAK-MARKER");
  // Naming the link itself is a file operand: it is resolved and refused.
  expect(readOnlyCommand("cat d/leak.txt", where)).toBe(false);
  expect(readOnlyCommand("grep -r x d/out", where)).toBe(false);
});

test("a single-quoted string is literal text: backslash, $, !, glob and bracket characters pass inside it, never outside", async () => {
  const { project, home, where } = await area();
  await mkdir(path.join(project, "src"));
  await writeFile(path.join(project, "src", "a.ts"), "foo\n"); await writeFile(path.join(project, "x"), "a\n");
  const yes = ["grep -rn 'foo\\.ts' src", "grep -n 'foo$' src/a.ts", "rg -n '\\bfoo\\b' src", "grep -E '^a|b$' x", "git log --grep='fix!'", "find . -name '*.ts'",
    "grep 'foo*' x", "grep -n 'a(b)[c]{d}?' x", "grep '<a>' x", "grep 'a\"b' x", "echo '$(touch MARK)'", "echo '`touch MARK`'", "grep 'a''b' x", "grep 'a'\"b\" x",
    "find . -path '*/src/*' -iname 'A*' -regex '.*'", "grep -n 'a#b' x", "echo \"it's\" 'x$y'", "grep '' x", "ls 'src'", "echo \"a\" '$HOME'", "echo '2>/dev/null'",
    "echo 'a;b|c&d'"];
  for (const line of yes) expect({ line, read: readOnlyCommand(line, where) }).toEqual({ line, read: true });
  const no = ["grep 'a x", "grep 'a\nb' x", "grep 'a\tb' x", "grep 'é' x", "grep \"a'$b\" x", "grep a\\'b' x", "grep $'a' x", "grep \"$x\" x", "grep \"a`b\" x", "grep a$ x", "grep a\\.b x", "grep a!b x", "grep a* x", "grep 'a'* x", "grep 'a' > out x", "cat x >out", "cat x >'out'", "echo 'a'>out",
    "cat < x", "echo 'a' #'", "echo a '#' #x", "grep '--output=x' x", "cat '*'x*", "cat 'a\\b'", "cat '..\\x'", "cat '~/x'", "cat ~'/x'", "echo 'a\u0001b'", "echo 'a\u007fb'",
    "echo '\u00a0'", "echo \"'$HOME'\"", "echo 'a'$'b'", "echo a#'b", "cat '", "cat x'", "cat ''' x"];
  for (const line of no) expect({ line, read: readOnlyCommand(line, where) }).toEqual({ line, read: false });
  if (posix) {
    for (const line of ["echo '$(touch MARK)'", "echo '`touch MARK`'", "grep 'a''b' x; echo done"]) { bash(line, project, home); expect(existsSync(path.join(project, "MARK"))).toBe(false); }
    expect(bash("echo 'a''b' '\\n$x'", project, home)).toBe("ab \\n$x\n");
    // A quoted glob given to find or grep is matched by the program, not expanded by the shell.
    await writeFile(path.join(project, "zzz.ts"), "q"); await writeFile(path.join(project, "A.ts"), "A");
    expect(bash("find . -maxdepth 1 -name '*.ts'", project, home).split("\n").sort().join(",")).toBe(",./A.ts,./zzz.ts");
    expect(bash("find . -maxdepth 1 -iname 'a*' -path '*A.ts'", project, home).trim()).toBe("./A.ts");
    expect(bash("grep -n 'foo$' src/a.ts", project, home)).toBe("1:foo\n");
  }
});

test("2>/dev/null, 2>&1, >/dev/null and 1>/dev/null on their own are harmless redirects; any other redirect asks", async () => {
  const { where } = await area();
  const yes = ["ls 2>/dev/null", "ls src 2>&1", "cat README.md >/dev/null", "cat README.md 2>/dev/null | head -5", "ls 2>&1 | grep a", "ls 2>/dev/null; cat README.md",
    "ls 2>/dev/null && cat README.md", "ls  >/dev/null  2>&1", "git status 2>&1", "find . -name '*.ts' 2>/dev/null | head", "ls 1>/dev/null", "ls 2>/dev/null\n",
    "echo '2>/dev/null' >/dev/null"];
  for (const line of yes) expect({ line, read: readOnlyCommand(line, where) }).toEqual({ line, read: true });
  const no = ["ls &>/dev/null", "ls 2>/dev/nullx", "ls 2>/dev/null>out", "ls 2>/dev/null&", "ls 2>&12", "ls 2>&1x", "ls>/dev/null", "ls 2> /dev/null", "ls 2>>/dev/null", "ls >>/dev/null",
    "ls 2>/dev/null/x", "ls >/dev/nul", "ls >/dev/tty", "ls 2>&-", "ls 3>&1", "ls 2>&3", "ls >&2", "ls >&/dev/null", "ls '2>/dev/null' >x", "ls &>>/dev/null", "ls &> /dev/null",
    "ls <&0", "ls 2>file", "ls >/dev/null/", "ls >./dev/null", "ls >//dev/null", "ls 2>/dev/null &", "ls 2>/dev/null\ncat README.md", "ls >/dev/null>x", "ls 2>&1>x"];
  for (const line of no) expect({ line, read: readOnlyCommand(line, where) }).toEqual({ line, read: false });
});

const dashPath = ["/bin/dash", "/usr/bin/dash", "/bin/sh"].find((file) => existsSync(file));

test("&>/dev/null asks: dash, busybox ash and ksh read it as 'run in the background', then run what follows", async () => {
  const { project, home, where } = await area();
  const line = "echo hi &>/dev/null touch MARK";
  for (const text of [line, "ls &>/dev/null", "ls &>/dev/null; cat README.md", "ls &> /dev/null", "ls &>>/dev/null", "ls 2>/dev/null &"]) {
    expect({ text, read: readOnlyCommand(text, where) }).toEqual({ text, read: false });
  }
  if (posix && dashPath) {
    spawnSync(dashPath, ["-c", line], { cwd: project, env: { PATH: process.env.PATH, HOME: home } });
    // /bin/sh on some systems is bash: only a real dash-like shell runs touch.
    const ranUnderSh = existsSync(path.join(project, "MARK"));
    if (/dash/.test(dashPath) || ranUnderSh) expect(ranUnderSh).toBe(true);
  }
  for (const text of ["ls 2>/dev/null", "ls 2>&1", "ls >/dev/null", "ls 1>/dev/null"]) expect(readOnlyCommand(text, where)).toBe(true);
});

/** A repository with a tracked .env and .ssh/config, in two commits. */
async function repoWithPrivate(dir: string) {
  const git = (...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
    { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH, HOME: dir, ...GIT_ENV } });
  await mkdir(path.join(dir, "src"), { recursive: true });
  git("init", "-q");
  await writeFile(path.join(dir, "README.md"), "readme KEYWORD");
  await writeFile(path.join(dir, "src", "a.ts"), "export const KEYWORD = 1;\n");
  git("add", "."); git("commit", "-q", "-m", "one");
  await mkdir(path.join(dir, ".ssh"));
  await writeFile(path.join(dir, ".env"), "KEYWORD=PRIVATE-ENV-VALUE\n");
  await writeFile(path.join(dir, ".ssh", "config"), "KEYWORD PRIVATE-SSH-VALUE\n");
  git("add", "-f", "."); git("commit", "-q", "-m", "two");
}

test("git path words with * ? [ ask: git expands the pathspec itself and prints private files the text check never sees", async () => {
  const { base, home } = await area();
  const dir = path.join(base, "gitproj");
  await repoWithPrivate(dir);
  const where = { root: dir, home, denyRead: [] as string[] };
  const printing = ["git grep -n '' -- '.en*'", "git grep --untracked -n KEYWORD -- '*'", "git grep -n KEYWORD -- 'src/*'", "git log -p -- '.e*'",
    "git diff HEAD~1 -- '.en*'", "git show HEAD -- '.en*'", "git grep -n KEYWORD -- '.ss*/config'", "git grep -n KEYWORD -- '.en?'", "git log -p -- '.en[v]'",
    "git grep -n KEYWORD '.en*'", "git log -p '.en*'", "git grep -n -e KEYWORD -- '.en*'"];
  for (const line of printing) {
    expect({ line, read: readOnlyCommand(line, where) }).toEqual({ line, read: false });
    if (posix && !/src\/\*/.test(line)) {
      const out = bash(line, dir, home);
      expect({ line, printed: /PRIVATE-(?:ENV|SSH)-VALUE/.test(out) }).toEqual({ line, printed: true });
    }
  }
  for (const line of ["git blame -- '.en*'", "git status -- '.en*'"]) expect({ line, read: readOnlyCommand(line, where) }).toEqual({ line, read: false });
  // A pattern keeps its * ? [ : it is not a path.
  const clean = path.join(base, "cleanproj");
  await mkdir(path.join(clean, "src"), { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: clean, env: { PATH: process.env.PATH, HOME: clean, ...GIT_ENV } });
  await writeFile(path.join(clean, "src", "a.ts"), "x\n");
  const cleanWhere = { root: clean, home, denyRead: [] as string[] };
  for (const line of ["git grep -n 'a.*b' -- src/a.ts", "git grep -n 'a[bc]?' src", "git log --grep='fix*' --oneline", "git log -S'a*' --oneline", "git grep -n -e 'a*' -- src",
    "git log --oneline -- src/a.ts", "git diff --stat -- src", "git show HEAD", "git grep -n x -- .", "git grep -n x"]) {
    expect({ line, read: readOnlyCommand(line, cleanWhere) }).toEqual({ line, read: true });
  }
  // The whole-folder rule is unchanged: a present .env makes a whole-folder grep ask; a named file does not.
  expect(readOnlyCommand("git grep -n KEYWORD", where)).toBe(false);
  expect(readOnlyCommand("git grep -n KEYWORD -- .", where)).toBe(false);
  expect(readOnlyCommand("git grep -n KEYWORD -- src/a.ts", where)).toBe(true);
});

test("git grep REV with no path narrows nothing: it reads the whole tree of that revision, so it follows the whole-folder rule", async () => {
  const { base, home } = await area();
  const dir = path.join(base, "gitproj2");
  await repoWithPrivate(dir);
  const where = { root: dir, home, denyRead: [] as string[] };
  if (posix) expect(bash("git grep KEYWORD HEAD", dir, home)).toContain("HEAD:.env:KEYWORD=PRIVATE-ENV-VALUE");
  for (const line of ["git grep KEYWORD HEAD", "git grep -n KEYWORD HEAD~1 HEAD", "git grep KEYWORD main", "git grep -n -e KEYWORD HEAD"]) {
    expect({ line, read: readOnlyCommand(line, where) }).toEqual({ line, read: false });
  }
  expect(readOnlyCommand("git grep KEYWORD HEAD -- src", where)).toBe(true);
  expect(readOnlyCommand("git grep KEYWORD src", where)).toBe(true);
  const clean = path.join(base, "cleanproj2");
  await mkdir(clean, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: clean, env: { PATH: process.env.PATH, HOME: clean, ...GIT_ENV } });
  expect(readOnlyCommand("git grep KEYWORD HEAD", { root: clean, home, denyRead: [] })).toBe(true);
});

test("git grep --cached reads the index: a private file tracked there but deleted from the work tree still prints, so it asks", async () => {
  const { base, home } = await area();
  const dir = path.join(base, "gitproj-cached");
  await repoWithPrivate(dir);
  await rm(path.join(dir, ".env"), { force: true });
  const where = { root: dir, home, denyRead: [] as string[] };
  if (posix) expect(bash("git grep --cached -n KEYWORD", dir, home)).toContain("PRIVATE-ENV-VALUE");
  for (const line of ["git grep --cached -n KEYWORD", "git grep --cached KEYWORD .", "git grep --cached --no-color KEYWORD", "git grep --recurse-submodules --cached KEYWORD"]) {
    expect({ line, read: readOnlyCommand(line, where) }).toEqual({ line, read: false });
  }
});

test("inside double quotes a backslash before an ordinary character and ! are plain text; $ ` \\\" \\\\ and newline are not", async () => {
  const { project, home, where } = await area();
  await mkdir(path.join(project, "src")); await writeFile(path.join(project, "src", "foo.ts"), "foo\n");
  const yes = ["grep -rn \"foo\\.ts\" src", "rg \"\\bfoo\\b\" src", "grep -E \"a\\|b\" README.md", "grep -n \"^\\s*foo\" README.md", "printf \"%s\\n\" hello",
    "echo \"a\\nb\"", "echo \"done!\"", "git log --grep=\"fix!\" --oneline", "echo \"it's\"", "echo \"a\\'b\"", "echo \"\\(x\\)\"", "grep -n \"\\.\\*\" README.md",
    "echo \"a\\!b\"", "printf \"%d\\n\" 5 | head -1", "echo \"a'b\" 'c\"d'"];
  for (const line of yes) expect({ line, read: readOnlyCommand(line, where) }).toEqual({ line, read: true });
  const no = ["echo \"a\\$b\"", "echo \"a\\`b\"", "echo \"a\\\"b\"", "echo \"a\\\\b\"", "echo \"a\\\nb\"", "echo \"a\\", "echo \"a\\\"", "echo \"\\\"; touch MARK; echo \\\"\"",
    "echo \"é\"", "echo \"a\\é\"", "echo \"a\\\tb\"", "echo \"a\tb\"", "echo \"a\u0001\"", "echo \"a\\\u0001\"", "echo \"$x\"", "echo \"`id`\"", "echo \"$(id)\"",
    "echo \"a\nb\"", "printf \"%n\" X", "printf \"%s\\n%n\" a X", "echo \"a\\$(touch MARK)\"", "echo \"\\\\\"; touch MARK; echo \"\\\\\"",
    "echo \"a\" #\"", "echo \"#\" #x", "echo \"a\\\"\"; touch MARK; echo \"b\""];
  for (const line of no) expect({ line, read: readOnlyCommand(line, where) }).toEqual({ line, read: false });
  expect(readOnlyCommand("echo \"a\\.b\" # c", where)).toBe(false);
  if (posix) {
    // Real bash: the backslash stays, ! stays, no command runs.
    expect(bash("echo \"a\\nb\" \"done!\" \"\\.\" \"\\s\"", project, home)).toBe("a\\nb done! \\. \\s\n");
    expect(bash("printf \"%s\\n\" hello", project, home)).toBe("hello\n");
    expect(bash("grep -rn \"foo\\.ts\" src; echo \"x\\|y\"", project, home)).toBe("x\\|y\n");
    // What stays refused really does something in bash: \" does not end the string, so the next quote opens a new one.
    bash("echo \"a\\\"\"; touch MARK; echo \"b\"", project, home);
    expect(existsSync(path.join(project, "MARK"))).toBe(true);
  }
});

test("Windows file-name tricks: a file operand with a colon after the first character, or a trailing space or dot, asks on every OS", async () => {
  const { project, where } = await area();
  const no = ["cat '.env::$DATA'", "cat '.env '", "cat '.env.'", "cat .env.", "cat '.env:x'", "cat 'a:b'", "head -n 1 '.env '", "tail '.env.'", "wc -l '.env::$DATA'",
    "sort '.env '", "stat '.env.'", "file '.env '", "diff README.md '.env.'", "grep KEY '.env '", "grep -r KEY '.env::$DATA'", "cat src/'a. '/x", "cat 'src /x'",
    "cat 'src./x'", "cat ' '", "cat 'x..'", "cat '...'", "cat 'D:x'", "find '.env ' -name x", "ls '.env.'", "cat README.md '.env.'",
    "grep -f '.env ' README.md", "cat 'a:'", "cat 'a/b:c/d'"];
  for (const line of no) expect({ line, read: readOnlyCommand(line, where) }).toEqual({ line, read: false });
  // Pattern arguments keep their characters; plain dots and spaces inside names are fine.
  const yes = ["grep -n 'a:b' README.md", "grep 'x. ' README.md", "grep -e 'a:b ' README.md", "rg -g '*.ts:x' foo", "cat ./README.md", "ls .", "ls ./", "cat 'a b'", "cat a.b",
    "grep -rn foo .", "cat a.b.c", "cat .gitignore", "date +%H:%M:%S", "git log --format='%h: %s' -5", "echo 'a: b. '", "cat src/."];
  for (const line of yes) expect({ line, read: readOnlyCommand(line, where) }).toEqual({ line, read: true });
  // git words are strings git matches, not files it opens: a revision range ending in dots and rev:path stay plain.
  expect(readOnlyCommand("git show HEAD:README.md", where)).toBe(false);
  expect(readOnlyCommand("git log --oneline main..", where)).toBe(true);
  expect(readOnlyCommand("git diff HEAD~1..", where)).toBe(true);
});

test("any git word with a colon asks (rev:path, :path, ::path, :(magic), a colon inside braces), before or after --; option values stay exempt", async () => {
  const { base, home } = await area();
  const dir = path.join(base, "gitcolon");
  await mkdir(dir, { recursive: true });
  const git = (...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
    { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH, HOME: dir, ...GIT_ENV } });
  git("init", "-q");
  await writeFile(path.join(dir, "README.md"), "readme\n");
  await writeFile(path.join(dir, ".env.local"), "SECRET=PRIVATE-LOCAL-VALUE\n");
  await writeFile(path.join(dir, ".npmrc"), "token=PRIVATE-NPM-VALUE\n");
  await writeFile(path.join(dir, ".netrc"), "password PRIVATE-NETRC-VALUE\n");
  git("add", "-f", "."); git("commit", "-q", "-m", "one: first");
  git("rm", "-q", ".netrc"); git("commit", "-q", "-m", "two");
  await writeFile(path.join(dir, "README.md"), "readme two\n");
  git("commit", "-q", "-am", "three");
  const where = { root: dir, home, denyRead: [] as string[] };
  const exploits = [
    "git grep --untracked -n SECRET -- :.env.local", "git log -p -- :.npmrc", "git log -p -- ::.npmrc",
    "git cat-file -p -- 'HEAD~2:.netrc'", "git cat-file -s -- 'HEAD~2:.netrc'", "git cat-file -e -- 'HEAD~2:.netrc'",
    "git cat-file blob -- 'HEAD~2:.netrc'", "git show 'HEAD~2^{/(:)}:.env.local'", "git cat-file -p 'HEAD~2^{/(:)}:.env.local'",
    "git diff 'HEAD~2^{/(:)}:.netrc' HEAD", "git show HEAD~2:.netrc", "git show :.env.local", "git show :0:.env.local",
    "git grep -n SECRET -- ':(glob).env.local'", "git log -p -- ':!src'", "git log -p -- ':/.npmrc'", "git show HEAD:README.md",
    "git diff HEAD~1:README.md HEAD:README.md", "git cat-file -p HEAD:README.md"];
  for (const line of exploits) expect({ line, read: readOnlyCommand(line, where) }).toEqual({ line, read: false });
  if (posix) {
    const shells = ["bash", ...(dashPath ? [dashPath] : [])];
    const proofs: Array<[string, RegExp]> = [
      ["git grep --untracked -n SECRET -- :.env.local", /PRIVATE-LOCAL-VALUE/], ["git log -p -- :.npmrc", /PRIVATE-NPM-VALUE/],
      ["git log -p -- ::.npmrc", /PRIVATE-NPM-VALUE/], ["git cat-file -p -- 'HEAD~2:.netrc'", /PRIVATE-NETRC-VALUE/],
      ["git cat-file -s -- 'HEAD~2:.netrc'", /^\d+\n$/], ["git show 'HEAD~2^{/(:)}:.env.local'", /PRIVATE-LOCAL-VALUE/],
      ["git cat-file -p 'HEAD~2^{/(:)}:.env.local'", /PRIVATE-LOCAL-VALUE/], ["git diff 'HEAD~2^{/(:)}:.netrc' 'HEAD~2^{/(:)}:.env.local'", /PRIVATE-NETRC-VALUE/]];
    for (const shell of shells) {
      for (const [line, pattern] of proofs) {
        const run = spawnSync(shell, ["-c", line], { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH, HOME: dir, ...GIT_ENV } });
        expect({ shell, line, printed: pattern.test(run.stdout) }).toEqual({ shell, line, printed: true });
      }
    }
  }
  // Still plain: no colon in a word, or the colon is inside an option's value.
  for (const line of ["git log --oneline -5", "git diff", "git status", "git show HEAD", "git log --grep='fix: x'", "git log --format=%H:%s -5",
    "git log --pretty=format:%h:%s -3", "git log -S 'a:b' --oneline", "git grep -n -e 'a:b' -- README.md", "git grep -n 'a:b' README.md",
    "git log --since=2.days.ago", "git blame -L 1,20 README.md", "git show refs/heads/main", "git log origin/main..HEAD --oneline", "git show HEAD~2",
    "git diff main..HEAD", "git show '@{u}'", "git show 'HEAD@{1}'", "git log -p"]) {
    expect({ line, read: readOnlyCommand(line, where) }).toEqual({ line, read: true });
  }
});
