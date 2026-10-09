import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSessionSandbox, runtimeShell, SHELL_DECLINED, type SandboxHost } from "../src/app/sandbox";
import { loadProjectContext } from "../src/project/context";
import { inspectProject } from "../src/project/inspect";
import { commandPrefix, matchesPrefix, readOnlyCommand } from "../src/sandbox/read-only";
import { SandboxStore } from "../src/sandbox/store";
import { fakeEngine } from "./support/sandbox-fakes";
import { removeTempDir } from "./support/temp-dir";

/**
 * With no sandbox (Windows, bubblewrap missing), commands that only read don't ask, and "don't ask again" covers a
 * command prefix (`npm test`, `git commit`), never a whole interpreter or a command with more in it.
 */

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => removeTempDir(root))); });

test("commands that only read are known; anything that writes, runs a program or redirects is not", () => {
  for (const command of ["ls -la", "pwd", "cat README.md", "git status", "git diff --stat", "git log --oneline -5", "grep -rn TODO src",
    "rg -n foo", "find . -name '*.ts'", "wc -l src/app.ts", "head -20 notes.md | grep x", "git status && git diff", "which bun", "tree src"]) {
    expect(readOnlyCommand(command)).toBe(true);
  }
  for (const command of ["rm -rf build", "npm test", "ls > files.txt", "cat a | tee b", "find . -delete", "find . -exec rm {} \\;",
    "git diff --output=patch.txt", "git commit -m x", "sort -o out.txt in.txt", "echo $(rm -rf /)", "ls `rm x`", "rg --pre ./run.sh foo",
    "python3 -c 'print(1)'", "FOO=1 ls", "ls & rm x", "git branch -D old", "uniq in.txt out.txt", "git -c core.pager=./x log"]) {
    expect(readOnlyCommand(command)).toBe(false);
  }
});

test("options that run a program are not reads: git grep -O, sort --compress-program, rg --hostname-bin", () => {
  for (const command of ["git grep -Osh touch", "git grep -O sh touch", "git grep --open-files-in-pager=sh x", "git grep --open-files-in-pager sh x",
    "git grep -nOsh x", "sort --compress-program=sh big.txt", "sort --compress-program sh big.txt", "sort -uo out.txt in.txt",
    "rg --hostname-bin=./x.sh foo", "rg --hostname-bin ./x.sh foo"]) {
    expect(readOnlyCommand(command)).toBe(false);
  }
});

test("a glob that can pick a private file, a link out of the project, a link-following search or jq is not a read", async () => {
  for (const command of ["cat .en*", "cat id_rs[a]", "cat .e{nv,x}", "jq -n env", "jq . package.json",
    "grep -R key docs", "grep -rnR key .", "rg -L key", "rg --follow key", "diff -r a b"]) {
    expect(readOnlyCommand(command)).toBe(false);
  }
  // * and ? are expanded here: files in the project are fine.
  expect(readOnlyCommand("ls src/*.ts")).toBe(true);
  // A quoted pattern is not a glob.
  expect(readOnlyCommand("find . -name '*.ts'")).toBe(true);
  expect(readOnlyCommand("grep -rn 'a*b' src")).toBe(true);
  const { home, project } = await fixture();
  await mkdir(path.join(home, ".ssh"));
  await writeFile(path.join(home, ".ssh", "id_rsa"), "KEY");
  await writeFile(path.join(home, "notes.txt"), "outside");
  await mkdir(path.join(project, "docs"));
  await writeFile(path.join(project, "docs", "readme.md"), "fine");
  await writeFile(path.join(project, "real.env.txt"), "fine");
  await symlink(path.join(home, ".ssh", "id_rsa"), path.join(project, "docs", "key"));
  await symlink(path.join(home, "notes.txt"), path.join(project, "notes"));
  await symlink(path.join(home, ".ssh"), path.join(project, "keys"));
  await symlink(path.join(project, "docs", "readme.md"), path.join(project, "inside-link"));
  for (const command of ["cat docs/key", "head notes", "cat keys/id_rsa", "ls keys", "grep -n x ./docs/key"]) {
    expect(readOnlyCommand(command, project)).toBe(false);
  }
  for (const command of ["cat docs/readme.md", "cat inside-link", "ls docs", "grep -rn fine docs", "cat missing.txt"]) {
    expect(readOnlyCommand(command, project)).toBe(true);
  }
});

test("only known commands with known options are reads: any option, variable or tool that can run a program asks", () => {
  for (const command of ["git grep -O sh x", "git grep --open-files-in-pager=sh x", "git -c core.pager=sh log", "git -c core.fsmonitor=x status",
    "git -c alias.x=!sh x", "git diff --ext-diff", "git log -p --ext-diff", "git diff --textconv", "git show --textconv HEAD", "git -C .. log",
    "git --git-dir=x log", "git grep --no-index key", "git shortlog -c", "git status --ignore-submodules=x", "rg --pre=sh x", "rg --pre sh x",
    "rg -z x", "rg --search-zip x", "rg -nz x", "rg --hostname-bin=x x", "sort --compress-program=sh x", "sort -T tmp x", "find . -exec id \\;",
    "find . -execdir id \\;", "find . -ok id \\;", "find . -fprint out", "find -L . -name x", "find . -follow", "xargs cat", "less README.md",
    "more README.md", "man ls", "awk 'BEGIN{system(\"id\")}' x", "sed -n 1p x", "sed 's/a/b/w out' x", "tar --to-command=sh -xf a.tar",
    "tar xf a --checkpoint-action=exec=sh", "GIT_PAGER=sh git log", "PAGER=sh git log", "LESSOPEN='|sh %s' cat x", "env git log", "tail -f log",
    "tail -F log", "date -s 2020-01-01", "hostname evil", "ls -L docs", "cat --follow x", "git branch newb", "git tag v1", "git remote add x y",
    "git stash", "git log --output=x", "git blame --contents=x a.ts", "head -c 10 x --files0-from=list", "wc --files0-from=list", "jq . x.json",
    "md5sum -c sums.txt", "uniq -f 1 in out", "git log -c core.pager=x", "rg --ignore-file x y"]) {
    expect({ command, read: readOnlyCommand(command) }).toEqual({ command, read: false });
  }
  for (const command of ["git log -p -5 --stat", "git log --oneline --graph --all", "git diff --cached --name-only", "git show HEAD~1 --stat",
    "git grep -n -i todo -- src", "git grep -nw todo", "git status -sb", "git rev-parse --show-toplevel", "git branch -a", "git branch --show-current",
    "git ls-files -m", "git blame -L 1,20 README.md", "rg -n --hidden -g '*.ts' foo src", "rg -uu foo", "grep -rn -A3 TODO src", "head -n 20 README.md",
    "tail -50 README.md", "wc -l README.md", "sort -u -k2 README.md", "cut -d: -f1 README.md", "ls -la src", "tree -L 2", "du -sh src", "date +%F",
    "echo hi", "find src -name '*.ts' -type f -maxdepth 2", "diff -u a b", "stat README.md", "uname -a"]) {
    expect({ command, read: readOnlyCommand(command) }).toEqual({ command, read: true });
  }
});

test("a read never prints a private file: the project's denyRead, keys under a project in your home, or a search of a folder that holds one", async () => {
  const { home, project } = await fixture();
  await mkdir(path.join(project, "secrets"));
  await writeFile(path.join(project, "secrets", "token.txt"), "TOKEN");
  await mkdir(path.join(project, "src"));
  await writeFile(path.join(project, "src", "a.ts"), "fine");
  const where = { root: project, home, denyRead: [path.join(project, "secrets")] };
  for (const command of ["cat secrets/token.txt", "head ./secrets/token.txt", "grep -rn TOKEN .", "grep -rn TOKEN", "rg TOKEN", "find . -name x", "cat src/../secrets/token.txt"]) {
    expect({ command, read: readOnlyCommand(command, where) }).toEqual({ command, read: false });
  }
  expect(readOnlyCommand("grep -rn fine src", where)).toBe(true);
  expect(readOnlyCommand("cat src/a.ts", where)).toBe(true);
  // A project that is your home folder: ~/.ssh and ~/.casper are still private.
  await mkdir(path.join(home, ".ssh"));
  await writeFile(path.join(home, ".ssh", "id_ed25519"), "KEY");
  await mkdir(path.join(home, ".casper"), { recursive: true });
  await writeFile(path.join(home, ".casper", "settings.json"), "{}");
  for (const command of ["cat .ssh/id_ed25519", "grep -rn KEY .", "cat .casper/settings.json", "ls .ssh"]) {
    expect({ command, read: readOnlyCommand(command, { root: home, home }) }).toEqual({ command, read: false });
  }
});

test("a prefix never covers a whole interpreter by another name, or a whole tool when an option comes first", () => {
  for (const command of ["python3.12 -c 'import os'", "py -c x", "powershell.exe -Command x", "cmd.exe /c del x", "node.exe x.js", "node20 x.js",
    "awk 'BEGIN{system(\"id\")}'", "gawk 1 x", "sed -n 1p x", "find . -delete", "osascript -e x", "tsx x.ts", "ts-node x.ts", "PYTHON.EXE x.py",
    "C:/Python312/python.exe x.py", "'C:\\Python312\\python.exe' x.py","/usr/bin/python3.11 x.py", "git -C sub commit -m x", "npm --prefix x test", "cargo +nightly build"]) {
    expect(commandPrefix(command)).toBeUndefined();
  }
  expect(commandPrefix("pip3 install -r req.txt")).toBe("pip3 install");
  expect(commandPrefix("npm.cmd test")).toBe("npm.cmd test");
});

test("a prefix is never a whole multi-purpose tool, or an interpreter run through another tool", () => {
  for (const command of ["git", "npm", "npx", "bun", "bunx", "node", "python", "sh", "bash", "zsh", "pwsh", "uv", "uvx", "pip", "cargo", "make",
    "docker", "kubectl", "ssh", "yarn node x.js", "uv run python x.py", "npm exec node x.js", "pnpm exec bash x", "bun run node x", "java -jar x.jar",
    "tar xf a.tar", "curl https://example.com", "wget x", "less x", "man ls", "vim x", "git -c alias.x=!sh x", "docker", "make -j4"]) {
    expect({ command, prefix: commandPrefix(command) }).toEqual({ command, prefix: undefined });
  }
  expect(commandPrefix("make build")).toBe("make build");
  expect(commandPrefix("git log -5")).toBe("git log");
  expect(commandPrefix("uv run pytest -q")).toBe("uv run pytest");
});

test("a prefix is the command and, for tools with subcommands, its subcommand; compound commands and interpreters get none", () => {
  expect(commandPrefix("npm test -- --watch")).toBe("npm test");
  expect(commandPrefix("git commit -m 'fix it'")).toBe("git commit");
  expect(commandPrefix("cargo build --release")).toBe("cargo build");
  expect(commandPrefix("make")).toBeUndefined();
  expect(commandPrefix("pytest -q tests")).toBe("pytest");
  for (const command of ["npm test; curl evil.example", "python3 script.py", "bash -c 'npm test'", "sudo npm test", "FOO=1 npm test", "npm test > out.txt", "npx anything"]) {
    expect(commandPrefix(command)).toBeUndefined();
  }
  expect(matchesPrefix("npm test -- --watch", "npm test")).toBe(true);
  expect(matchesPrefix("npm testx", "npm test")).toBe(false);
  expect(matchesPrefix("npm test && curl evil.example", "npm test")).toBe(false);
  expect(matchesPrefix("npm run build", "npm test")).toBe(false);
});

test("a saved prefix matches the tool by its plain name, and only whole words match, never odd spaces", () => {
  expect(matchesPrefix("npm.cmd test", "npm test", true)).toBe(true);
  expect(matchesPrefix("npm test", "npm.cmd test", true)).toBe(true);
  expect(matchesPrefix("npm.cmd test -- --watch", "npm test", true)).toBe(true);
  expect(matchesPrefix("npm.cmd test", "npm test", false)).toBe(false);
  expect(matchesPrefix("NPM Test", "npm test", false)).toBe(false);
  expect(matchesPrefix("NPM test", "npm test", true)).toBe(true);
  // Only the program name is relaxed on Windows: a script, a target or a file name is case-sensitive.
  expect(matchesPrefix("NPM Test", "npm test", true)).toBe(false);
  expect(matchesPrefix("npm run Build", "npm run build", true)).toBe(false);
  expect(matchesPrefix("npm.cmd run build", "npm run build", true)).toBe(true);
  expect(matchesPrefix("NPM.CMD test", "npm test", false)).toBe(false);
  expect(matchesPrefix("npm   test", "npm test")).toBe(true);
  // The shell reads these spaces as part of a word, so "npm<no-break space>test" is one program, not npm test.
  for (const space of ["\u00a0", "\u3000", "\f", "\v", "\u2003"]) {
    for (const windows of [false, true]) expect({ space, windows, match: matchesPrefix(`npm${space}test`, "npm test", windows) }).toEqual({ space, windows, match: false });
  }
  for (const command of ["./npm test", "/tmp/npm test", "C:\\tmp\\npm.cmd test", "\uFF2E\uFF30\uFF2D test", "npm\u200b test", "npm\ttest; curl x",
    "npm test && curl x"]) {
    expect({ command, match: matchesPrefix(command, "npm test", true) }).toEqual({ command, match: false });
  }
  // Other program names never match on any platform; only Windows endings are dropped, and only on Windows.
  for (const windows of [false, true]) {
    for (const command of ["npm2 test", "npm-1.2 test", "npm- test", "npm. test", "npm.1 test"]) {
      expect({ command, windows, match: matchesPrefix(command, "npm test", windows) }).toEqual({ command, windows, match: false });
    }
    expect(matchesPrefix("make-4", "make", windows)).toBe(false);
    expect(matchesPrefix("ls2 -la", "ls", windows)).toBe(false);
  }
  expect(matchesPrefix("npm.com test", "npm test", false)).toBe(false);
  expect(matchesPrefix("npm.bat test", "npm test", false)).toBe(false);
  // The check looks at the line as typed: trimming first would strip a leading or trailing no-break space and let it through.
  for (const space of ["\u00a0", "\u3000", "\ufeff", "\u2003", "\f", "\v"]) {
    for (const windows of [false, true]) {
      expect({ space, windows, lead: matchesPrefix(`${space}npm test`, "npm test", windows), trail: matchesPrefix(`npm test${space}`, "npm test", windows) })
        .toEqual({ space, windows, lead: false, trail: false });
    }
  }
  // A program word with a folder never relaxes, whatever the shell's escape rules did to it.
  for (const command of ["\\npm.cmd test", "\\\\npm.cmd test", "\"C:\\tmp\\npm.cmd\" test", ".\\npm.cmd test", "C:\\tmp\\npm.cmd test", "x/npm.cmd test"]) {
    expect({ command, match: matchesPrefix(command, "npm test", true) }).toEqual({ command, match: false });
  }
  // Windows folds ASCII case only: the Kelvin sign is not a k. A program word that is only an ending keeps it.
  expect(matchesPrefix("\u212Aubectl get", "kubectl get", true)).toBe(false);
  expect(matchesPrefix("Kubectl get", "kubectl get", true)).toBe(true);
  expect(matchesPrefix(".cmd test", ".exe test", true)).toBe(false);
  expect(matchesPrefix(".bat test", "", true)).toBe(false);
});

async function fixture() {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-no-sandbox-")));
  roots.push(base);
  const home = path.join(base, "home"), project = path.join(base, "project");
  await mkdir(home); await mkdir(project);
  const context = await loadProjectContext(await inspectProject(project), { homeDir: home });
  return { home, project, context };
}

function host(answers: Array<string | undefined>, canAsk = true) {
  const asked: Array<{ question: string; options: string[] }> = [];
  const value: SandboxHost = {
    canAsk: () => canAsk,
    pick: async (question, options) => { asked.push({ question, options: options.map((option) => option.label) }); return answers.shift(); },
    write: () => {},
    planning: () => false,
  };
  return { value, asked };
}

test("with no sandbox, ls and git status run without a box, even where nobody can ask", async () => {
  const { home, project, context } = await fixture();
  for (const canAsk of [true, false]) {
    const terminal = host([], canAsk);
    const sandbox = createSessionSandbox(terminal.value, context, { root: () => project, home, seams: { engine: fakeEngine(), platform: "win32" } });
    const shell = runtimeShell(terminal.value, sandbox, new SandboxStore(context.stateDirectory));
    expect(await shell.approve!("ls -la")).toBeUndefined();
    expect(await shell.approve!("git status")).toBeUndefined();
    expect(terminal.asked).toEqual([]);
  }
});

test("the box offers the yes-words and names the prefix; Yes, for this session covers commands starting with it", async () => {
  const { home, project, context } = await fixture();
  const terminal = host(["Yes, for this session", undefined]);
  const sandbox = createSessionSandbox(terminal.value, context, { root: () => project, home, seams: { engine: fakeEngine(), platform: "win32" } });
  const shell = runtimeShell(terminal.value, sandbox, new SandboxStore(context.stateDirectory));
  expect(await shell.approve!("npm test")).toBeUndefined();
  expect(terminal.asked).toEqual([{ question: "Run this command?  npm test", options: ["No", "Yes, this once", "Yes, for this session", "Yes, always for this project"] }]);
  expect(await shell.approve!("npm test -- --watch")).toBeUndefined();
  expect(terminal.asked).toHaveLength(1);
  // More in it, or another command: it asks.
  expect(await shell.approve!("npm test && curl evil.example")).toBe(SHELL_DECLINED);
  expect(terminal.asked).toHaveLength(2);
});

test("Yes, always for this project keeps the prefix in ~/.casper; the next session doesn't ask", async () => {
  const { home, project, context } = await fixture();
  const terminal = host(["Yes, always for this project"]);
  const sandbox = createSessionSandbox(terminal.value, context, { root: () => project, home, seams: { engine: fakeEngine(), platform: "win32" } });
  const shell = runtimeShell(terminal.value, sandbox, new SandboxStore(context.stateDirectory));
  expect(await shell.approve!("cargo build --release")).toBeUndefined();
  expect(JSON.parse(await readFile(path.join(context.stateDirectory, "sandbox.json"), "utf8")).prefixes).toEqual(["cargo build"]);
  const next = host([]);
  const later = createSessionSandbox(next.value, context, { root: () => project, home, seams: { engine: fakeEngine(), platform: "win32" } });
  const nextShell = runtimeShell(next.value, later, new SandboxStore(context.stateDirectory));
  expect(await nextShell.approve!("cargo build")).toBeUndefined();
  expect(next.asked).toEqual([]);
});

test("a command with no prefix (an interpreter, or more in it) is remembered exactly", async () => {
  const { home, project, context } = await fixture();
  const terminal = host(["Yes, for this session", undefined]);
  const sandbox = createSessionSandbox(terminal.value, context, { root: () => project, home, seams: { engine: fakeEngine(), platform: "win32" } });
  const shell = runtimeShell(terminal.value, sandbox, new SandboxStore(context.stateDirectory));
  expect(await shell.approve!("python3 tools/gen.py")).toBeUndefined();
  expect(await shell.approve!("python3 tools/gen.py")).toBeUndefined();
  expect(await shell.approve!("python3 -c 'import os'")).toBe(SHELL_DECLINED);
  expect(terminal.asked).toHaveLength(2);
});

test("with no sandbox, a read of a private file in a project that is your home folder asks", async () => {
  const { home, context } = await fixture();
  await mkdir(path.join(home, ".kube"));
  await writeFile(path.join(home, ".kube", "config"), "KEY");
  const terminal = host([undefined]);
  const sandbox = createSessionSandbox(terminal.value, context, { root: () => home, home, seams: { engine: fakeEngine(), platform: "win32" } });
  const shell = runtimeShell(terminal.value, sandbox, new SandboxStore(context.stateDirectory));
  expect(await shell.approve!("cat .kube/config")).toBe(SHELL_DECLINED);
  expect(terminal.asked).toHaveLength(1);
});

test("a whole-folder search that prints contents asks when the folder holds a .env or a key; listings don't", async () => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-no-sandbox-search-")));
  try {
    const root = path.join(base, "proj");
    await mkdir(path.join(root, "src", "deep"), { recursive: true });
    await writeFile(path.join(root, "a.txt"), "hi\n");
    await writeFile(path.join(root, "src", "b.ts"), "hi\n");
    const where = { root, home: path.join(base, "home") };
    // No private file anywhere: searches run.
    for (const command of ["grep -r hi .", "rg hi", "git grep hi"]) expect(readOnlyCommand(command, where)).toBe(true);
    await writeFile(path.join(root, "src", "deep", ".env"), "TOKEN=1\n");
    for (const command of ["grep -r '' .", "grep -r hi src", "rg -uu '' .", "rg hi", "rg hi src", "git grep hi"]) {
      expect([command, readOnlyCommand(command, where)]).toEqual([command, false]);
    }
    // A search of a folder without one still runs, and listings only show names.
    await mkdir(path.join(root, "docs"));
    await writeFile(path.join(root, "docs", "c.md"), "hi\n");
    for (const command of ["grep -r hi docs", "rg hi docs", "tree", "find . -name '*.ts'", "du -sh .", "ls -R"]) {
      expect([command, readOnlyCommand(command, where)]).toEqual([command, true]);
    }
  } finally { await removeTempDir(base); }
});

test("an option that takes a value never hides another option behind it: -n --output, -U --no-index, --abbrev --contents= ask", () => {
  for (const command of ["git diff -U --no-index -U ../x README.md", "git log -U --output=../x", "git blame --abbrev --contents=../x README.md",
    "git log -n --output=x", "git show -n --ext-diff HEAD", "head -n --files0-from=list x", "git diff -U --output x"]) {
    expect({ command, read: readOnlyCommand(command) }).toEqual({ command, read: false });
  }
  for (const command of ["head -n -5 README.md", "tail -n +5 README.md", "git log -n 3", "git diff -U5", "git diff --unified=5",
    "git blame --abbrev=7 README.md", "git blame -L 1,20 README.md"]) {
    expect({ command, read: readOnlyCommand(command) }).toEqual({ command, read: true });
  }
});

test("git's -U, --unified and --abbrev take only a joined value: the next word is a file and is checked", async () => {
  const { home, project } = await fixture();
  await mkdir(path.join(project, "secrets"));
  const where = { root: project, home, denyRead: [path.join(project, "secrets")] };
  for (const command of ["git blame --abbrev secrets/k.txt", "git blame --abbrev .env", "git log -U secrets/k.txt", "git show -U HEAD:.env",
    "git show -U HEAD:secrets/k.txt", "git diff -U .env", "git show --unified HEAD:.env", "git describe --abbrev HEAD:secrets/k.txt"]) {
    expect({ command, read: readOnlyCommand(command, where) }).toEqual({ command, read: false });
  }
  for (const command of ["git show -U HEAD~1", "git blame --abbrev src/a.ts", "git log -U5 src/a.ts"]) {
    expect({ command, read: readOnlyCommand(command, where) }).toEqual({ command, read: true });
  }
});

test("a git reader's <rev>:<path> is checked as that path: a private or denyRead file asks", async () => {
  const { home, project } = await fixture();
  await mkdir(path.join(project, "secrets"));
  const where = { root: project, home, denyRead: [path.join(project, "secrets")] };
  for (const command of ["git show HEAD:secrets/token.txt", "git show HEAD:.env", "git show :.env", "git show :0:.env", "git cat-file -p HEAD:.env",
    "git cat-file -p HEAD:secrets/token.txt", "git diff HEAD:secrets/a HEAD:src/a", "git diff -- ':(glob).env'", "git log -p -- ':!src'",
    "git show HEAD:../outside.txt"]) {
    expect({ command, read: readOnlyCommand(command, where) }).toEqual({ command, read: false });
  }
  for (const command of ["git show HEAD~2", "git show HEAD~1 --stat", "git cat-file -p HEAD", "git show HEAD", "git log -p -5 --stat"]) {
    expect({ command, read: readOnlyCommand(command, where) }).toEqual({ command, read: true });
  }
});

test("key and secret files ask like .env: *.key, *.env, .envrc, .pgpass, credentials and secrets files", async () => {
  const { home, project } = await fixture();
  for (const name of ["certs/server.key", "config/dev.env", ".envrc", "secrets.yaml", "terraform.tfvars", "terraform.tfstate", ".pgpass",
    "aws.credentials", "client.ovpn", "certs/server-key.pem", "certs/privkey.pem", "store.p12", "SERVER.KEY", ".dockercfg", "_netrc"]) {
    expect({ name, read: readOnlyCommand(`cat ${name}`, { root: project, home }) }).toEqual({ name, read: false });
  }
  for (const name of ["real.env.txt", "certs/ca.pem", "tox.ini", "src/secrets.ts", "keyboard.ts", "docs/keys.md"]) {
    expect({ name, read: readOnlyCommand(`cat ${name}`, { root: project, home }) }).toEqual({ name, read: true });
  }
});

test("programs that run another command get no prefix: su, runuser, pkexec, tmux, screen, crontab, at, pypy", () => {
  for (const command of ["su -c id", "runuser -u x id", "pkexec id", "tmux new -d 'x'", "screen -dm x", "crontab f", "at now", "batch",
    "pypy3 -c 1", "luajit x.lua"]) {
    expect({ command, prefix: commandPrefix(command) }).toEqual({ command, prefix: undefined });
  }
  expect(commandPrefix("rm -rf build")).toBe("rm");
});
