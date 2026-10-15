import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_SYSTEM_PROMPT_APPEND, LEAN_SYSTEM_PROMPT_APPEND } from "../src/app/prompt";
import { runtimeShell } from "../src/app/sandbox";
import { YES_ALWAYS, YES_SESSION } from "../src/app/safe-choices";
import { ShellSandbox } from "../src/sandbox/manager";
import { answerKey, readOnlyCommand, testRunKey } from "../src/sandbox/read-only";
import { routineCommand } from "../src/sandbox/routine";
import { SandboxStore } from "../src/sandbox/store";
import { removeTempDir } from "./support/temp-dir";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(routine = true, answer: string = YES_SESSION) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-important-")));
  cleanup.push(() => removeTempDir(base));
  const root = path.join(base, "project"), home = path.join(base, "home");
  for (const folder of [home, path.join(root, ".git"), path.join(root, ".casper"), path.join(root, "sub"), path.join(root, "tests")]) await mkdir(folder, { recursive: true });
  await writeFile(path.join(root, ".git", "config"), '[remote "origin"]\n url = https://example.com/project.git\n');
  const where = { root, home, denyRead: [path.join(root, "private")] };
  const store = new SandboxStore(path.join(base, "state"));
  const sandbox = new ShellSandbox({ root: () => root, home, store, offByDefault: true, settings: { project: { denyRead: ["private"] } } });
  cleanup.push(() => sandbox.close());
  const asked: string[] = [];
  const shell = runtimeShell({ canAsk: () => true, pick: async (question) => { asked.push(question); return answer; }, write() {}, planning: () => false, routineCommands: () => routine }, sandbox, store);
  cleanup.push(() => shell.close());
  return { root, home, where, shell, asked, store };
}

const READS = [
  "git status --short; git diff --stat; git branch --show-current; git config user.name; git config user.email",
  "git diff -- file; git remote -v; command -v tmux; command -v gh; git log -1 --oneline; git branch -r --contains HEAD",
  "ps -ax -o pid,ppid,pcpu,etime,args | grep -E 'bun' | head -n 15",
  "git config --get user.name", "git config --global user.name", "git config --global --get user.email",
  "git config --get-all remote.origin.url",
  "command -v bun git", "command -V bun", "type bun", "type -a git", "which -a bun", "ps aux", "ps --sort=-pcpu -eo pid,args",
  "date", "date -u +%F", "uname", "uname -a", "uname --machine",
];
const ROUTINE = [
  "bun test --parallel tests/a.test.ts > .casper/x.log 2>&1",
  "bun test --parallel tests/a.test.ts > .casper/x.log 2>&1; result=$?; tail -n 100 .casper/x.log; exit $result",
  "git status; git diff --check; git fetch origin; git merge-base HEAD origin/main; git rev-parse origin/main",
  "git fetch", "git fetch --depth 1 origin main", "git fetch --no-prune origin", "git fetch origin main:refs/remotes/origin/main",
  "git status > status.txt", "git status >> status.txt", "git status 2> errors.txt", "git status 1>> status.txt 2>&1",
  "git status > 'status report.txt'", "git status >status.txt", "bun test > .casper/x.log; code=$?; exit 0",
  "cd sub && bun test > run.log", "cd sub; git status >> run.log", "bun test > .casper/x.log 2>&1 | tail -n 15",
  "bun test; _status=$?; exit $_status", "bun test; exit 2",
];
const ASKS = [
  "git config --list", "git config --global --list", "git config -l",
  "git config user.name x", "git config --global user.email x", "git config --unset user.name", "git config --unset-all user.name",
  "git config --add user.name x", "git config --edit", "git config -e", "git config --replace-all user.name x",
  "git config --global --list user.name", "git config --get user.name pattern", "git config --file ../config --get user.name",
  "command bun test", "command -p bun test", "command -v", "date -s 2020-01-01",
  "git status > ../outside.log", "bun test > .git/config", "bun test >> sub/.git/config", "bun test > .env",
  "bun test > private/log", "bun test > .", "bun test > /dev/zero", "bun test > log*", "bun test > \"$HOME/x\"",
  "bun test &> log", "bun test 3> log", "bun test < input", "bun test > log 2>&3", "bun test > log; sudo reboot",
  "bun test; result=$(pwd); exit $result", "bun test; result=$HOME; exit $result", "echo $HOME", "echo $(pwd)", "(bun test)",
  "bun test; result=$? echo hi", "bun test; PATH=$?; git status", "bun test; IFS=$?; git status", "bun test; exit ${result}",
  "bun test; exit $result extra", "bun test; result=$?; echo $result", "bun test; result=$?; sh script.sh",
  "git switch other; echo overwritten > run.log", "bun test; git status > run.log",
  "git fetch --prune", "git fetch -p origin", "git fetch --prun origin", "git fetch --prune-tags origin", "git fetch --force origin",
  "git fetch origin +main:main", "git fetch origin :main", "git fetch origin main:main", "git fetch --refmap=x origin",
  "git fetch --upload-pack=sh origin", "git fetch --upload-pa=sh origin", "git fetch upstream", "git fetch --stdin origin",
  "python3 <<'PY'\nimport urllib.request\nprint(urllib.request.urlopen('https://example.com').read())\nPY",
];

test("the live session's reads and routine commands do not show a box", async () => {
  const { where, shell, asked } = await fixture();
  for (const command of READS) expect({ command, reads: readOnlyCommand(command, where) }).toEqual({ command, reads: true });
  for (const command of [...READS, ...ROUTINE]) {
    expect({ command, routine: routineCommand(command, where) }).toEqual({ command, routine: true });
    expect(await shell.approve!(command)).toBeUndefined();
    expect(asked).toEqual([]);
  }
  // Redirects are project writes, never promoted to reader-tool permissions.
  for (const command of ROUTINE.filter((value) => value.includes("> .") || value.includes(">status") || value.includes("> status"))) expect(readOnlyCommand(command, where)).toBe(false);
});

test("mutations, private/outside redirects, expansion and non-routine commands still ask", async () => {
  const { where, shell, asked, store } = await fixture();
  for (const command of ASKS) {
    expect({ command, reads: readOnlyCommand(command, where), routine: routineCommand(command, where) }).toEqual({ command, reads: false, routine: false });
    store.sessionCommands.clear();
    const count = asked.length;
    await shell.approve!(command);
    expect({ command, boxes: asked.length - count }).toEqual({ command, boxes: 1 });
  }
});

test("redirects resolve cwd and links and never reach git, private state, or outside the project", async () => {
  const { root, home, where } = await fixture();
  await mkdir(path.join(root, "private"));
  await symlink(home, path.join(root, "out"), "junction");
  await symlink(path.join(root, ".git"), path.join(root, "git-link"), "junction");
  await symlink(path.join(root, "private"), path.join(root, "private-link"), "junction");
  for (const command of ["bun test > out/log", "bun test >> git-link/config", "bun test > private-link/log", "cd sub && bun test > ../../log", "bun test > sub/../log"]) expect({ command, routine: routineCommand(command, where) }).toEqual({ command, routine: false });
  const absolute = path.join(root, "run.log").split(path.sep).join("/");
  expect(routineCommand(`bun test > '${absolute}'`, where)).toBe(true);
  const privatePath = path.join(home, ".casper", "log").split(path.sep).join("/");
  expect(routineCommand(`bun test > '${privatePath}'`, where)).toBe(false);
});

test("worktree copies remain readable without opening private state or explicit denyRead paths", async () => {
  const { home } = await fixture();
  const root = path.join(home, ".casper", "worktrees", "project", "builder");
  await mkdir(root, { recursive: true });
  await mkdir(path.join(root, "hidden"));
  await mkdir(path.join(home, ".ssh"));
  await symlink(path.join(home, ".ssh"), path.join(root, "keys"), "junction");
  const where = { root, home, denyRead: [path.join(root, "hidden")] };
  expect(readOnlyCommand("git diff --check; git diff -- src/app/sandbox.ts", where)).toBe(true);
  expect(routineCommand("bun test > run.log", where)).toBe(true);
  for (const command of ["cat .env", "cat keys/id_rsa", "cat hidden/file.txt", "cat ../../../../config.yaml"]) expect(readOnlyCommand(command, where)).toBe(false);
  for (const command of ["bun test > hidden/run.log", "bun test > keys/run.log", "bun test > ../../../../run.log"]) expect(routineCommand(command, where)).toBe(false);
});

test("session yes matches bun test across project files and different tails, even with routine work disabled", async () => {
  const { where, shell, asked } = await fixture(false);
  const first = "bun test --parallel tests/a.test.ts > .casper/x.log 2>&1; result=$?; tail -n 100 .casper/x.log; exit $result";
  const rerun = "bun test --parallel tests/b.test.ts tests/c.test.ts > .casper/y.log 2>&1; code=$?; tail -n 40 .casper/y.log; exit $code";
  expect(testRunKey(first, where)).toBe(testRunKey(rerun, where));
  await shell.approve!(first);
  await shell.approve!(rerun);
  await shell.approve!("bun test tests/d.test.ts 2>&1 | tail -n 10");
  for (const prefix of ['TMPDIR="$PWD/x"', 'HOME="$PWD/x"', 'GIT_CEILING_DIRECTORIES="$PWD/x"']) await shell.approve!(`${prefix} bun test tests/e.test.ts | tail -20`);
  await shell.approve!("set -o pipefail; bun test tests/f.test.ts | grep pass");
  await shell.approve!("set -e; bun test tests/g.test.ts | tail -20");
  expect(asked).toHaveLength(1);
  for (const command of ["bun test ../outside.test.ts", "bun test .env", "bun test > .git/config", "bun test --preload ../outside.ts", "bun test; git commit -m x", "bun test; cat output.txt", "bun test; tail -n 10 other.log", "cat script | bun test", "cd sub && bun test tests/a.test.ts", "npm test tests/a.test.ts", testRunKey(first, where)!]) {
    const count = asked.length;
    await shell.approve!(command);
    expect({ command, boxes: asked.length - count }).toEqual({ command, boxes: 1 });
  }
});

test("session test approvals are listed and can be forgotten without becoming executable command approvals", async () => {
  const { shell, store, asked } = await fixture(false);
  await shell.approve!("bun test tests/a.test.ts");
  const key = [...store.sessionTestRuns][0]!;
  expect(store.sessionCommands.size).toBe(0);
  expect(await store.allowed()).toEqual([{ kind: "command", value: key, session: true }]);
  expect(await store.removeCommand(key)).toBe(true);
  expect(store.sessionTestRuns.size).toBe(0);
  await shell.approve!("bun test tests/b.test.ts");
  expect(asked).toHaveLength(2);
  expect(await store.forgetAll()).toBe(1);
  expect(store.sessionTestRuns.size).toBe(0);
  await shell.approve!("bun test tests/c.test.ts");
  expect(asked).toHaveLength(3);
});

test("permanent test approvals keep exact matching instead of remembering the runner family", async () => {
  const { shell, asked, store } = await fixture(false, YES_ALWAYS);
  const first = "bun test tests/a.test.ts > .casper/a.log; result=$?; tail -n 10 .casper/a.log; exit $result";
  const second = "bun test tests/b.test.ts > .casper/b.log; code=$?; tail -n 20 .casper/b.log; exit $code";
  await shell.approve!(first); await shell.approve!(first); await shell.approve!(second);
  expect(asked).toHaveLength(2);
  expect(store.sessionCommands.size).toBe(0);
  expect((await store.allowed()).map(({ value, session }) => ({ value, session }))).toEqual([
    { value: first, session: false }, { value: second, session: false },
  ]);
});

test("full and lean guidance steer tests and page reads to dedicated tools, not shell plumbing", async () => {
  for (const prompt of [DEFAULT_SYSTEM_PROMPT_APPEND, LEAN_SYSTEM_PROMPT_APPEND]) {
    expect(prompt).toContain("casper_check, not shell log wrappers");
    expect(prompt).toContain("web_fetch, not python/curl");
  }
  for (const file of ["src/verify/task.ts", "src/runtime/guidance.ts"]) expect(await readFile(file, "utf8")).toContain("not shell log wrappers");
  for (const file of ["src/web/tools.ts", "src/runtime/guidance.ts"]) expect(await readFile(file, "utf8")).toContain("not python/curl");
});

test("approval behavior is documented in security, terminal UX and its historical ADR", async () => {
  for (const file of ["docs/SECURITY.md", "docs/TERMINAL_UX.md", "docs/adr/0002-deliberate-choices.md"]) {
    const text = await readFile(file, "utf8");
    expect(text).toContain("bun test");
    expect(text).toMatch(/head\/gap\/tail|head.*tail|eight head lines/);
    expect(text).toContain("copy");
  }
});

test("release notes exclude workflow-only owner-review instructions", async () => {
  expect(await readFile("docs/RELEASE.md", "utf8")).not.toContain("Owner review required before merge");
});

test("non-test approvals keep exact matching, including redirects",  async () => {
  const { where, shell, asked } = await fixture(false);
  const first = "node script-a.js > a.log", second = "node script-b.js > b.log";
  expect(answerKey(first, where)).toBe(first);
  expect(testRunKey(first, where)).toBeUndefined();
  await shell.approve!(first); await shell.approve!(first); await shell.approve!(second);
  expect(asked).toHaveLength(2);
});
