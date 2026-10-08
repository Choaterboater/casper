import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { allowedCommand } from "../src/app/allowed";
import { createSessionSandbox, runtimeShell, SHELL_DECLINED, type SandboxHost } from "../src/app/sandbox";
import { loadProjectContext } from "../src/project/context";
import { inspectProject } from "../src/project/inspect";
import { SandboxStore } from "../src/sandbox/store";
import { fakeEngine } from "./support/sandbox-fakes";
import { removeTempDir } from "./support/temp-dir";

/** /allowed: the commands you said yes to for this project, listed in plain words, and how to take them back. */

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => removeTempDir(root))); });

async function fixture() {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-allowed-")));
  roots.push(base);
  const home = path.join(base, "home"), project = path.join(base, "project");
  await mkdir(home); await mkdir(project);
  const context = await loadProjectContext(await inspectProject(project), { homeDir: home });
  return { home, project, context, store: new SandboxStore(context.stateDirectory) };
}

function run(store: SandboxStore) {
  return async (line: string) => { let text = ""; await allowedCommand(line, store, (chunk) => { text += chunk; }); return text; };
}

async function filled() {
  const f = await fixture();
  await f.store.addPrefix("git log");
  await f.store.addPrefix("npm test");
  await f.store.addCommand("python3 tools/gen.py");
  f.store.sessionPrefixes.add("cargo build");
  f.store.sessionCommands.add("make -j4 all");
  return { ...f, say: run(f.store) };
}

test("/allowed lists the saved prefixes, the exact commands and the session ones in one numbered list", async () => {
  const { say } = await filled();
  const text = await say("/allowed");
  const lines = text.split("\n");
  expect(lines.filter((line) => /^\s+\d+\. /.test(line)).map((line) => line.trim())).toEqual([
    "1. git log (and anything after it)",
    "2. npm test (and anything after it)",
    "3. python3 tools/gen.py (this exact command)",
    "4. cargo build (and anything after it) (this session)",
    "5. make -j4 all (this exact command) (this session)",
  ]);
  expect(text).toContain("/allowed forget 3");
  expect(text).toContain("/allowed forget all");
});

test("with nothing allowed, /allowed says so and says how a yes gets here", async () => {
  const { store } = await fixture();
  const text = await run(store)("/allowed");
  expect(text).toContain("Nothing is allowed yet");
  expect(text).not.toMatch(/^\s+1\. /m);
});

test("a saved command with a token in it is shown the way the approval box shows it, scrubbed", async () => {
  const { store } = await fixture();
  await store.addCommand("curl -H 'api_key: deadbeef1234abcd' https://example.com/x");
  store.sessionCommands.add("API_TOKEN=deadbeef1234abcd ./run.sh");
  const text = await run(store)("/allowed");
  expect(text).not.toContain("deadbeef1234abcd");
  expect(text).toContain("<secret hidden>");
  // The scrubbed text finds the entry too.
  expect(await run(store)("/allowed forget curl -H 'api_key: <secret hidden>' https://example.com/x")).toContain("Forgot");
  expect(await store.allowsCommand("curl -H 'api_key: deadbeef1234abcd' https://example.com/x")).toBe(false);
});

test("/allowed forget 3 removes that entry after the list was shown, and it stays gone", async () => {
  const { say, context, store } = await filled();
  await say("/allowed");
  const text = await say("/allowed forget 3");
  expect(text).toContain("Forgot 3");
  expect(text).toContain("python3 tools/gen.py");
  expect(await store.allowsCommand("python3 tools/gen.py")).toBe(false);
  expect(await store.allowsCommand("git log -5")).toBe(true);
  const saved = JSON.parse(await readFile(path.join(context.stateDirectory, "sandbox.json"), "utf8"));
  expect(saved.commands).toEqual([]);
  expect(saved.prefixes).toEqual(["git log", "npm test"]);
  expect(await new SandboxStore(context.stateDirectory).allowsCommand("python3 tools/gen.py")).toBe(false);
});

test("forgetting a session entry by number takes it back for this session", async () => {
  const { say, store } = await filled();
  await say("/allowed");
  expect(await say("/allowed forget 4")).toContain("Forgot 4");
  expect([...store.sessionPrefixes]).toEqual([]);
  expect([...store.sessionCommands]).toEqual(["make -j4 all"]);
});

test("/allowed forget git log removes the saved prefix by its words, and a command by its words", async () => {
  const { say, store, context } = await filled();
  expect(await say("/allowed forget git log")).toContain("Forgot git log");
  expect(await store.allowsCommand("git log -5")).toBe(false);
  expect(await say("/allowed forget  python3   tools/gen.py")).toContain("Forgot");
  expect(await say("/allowed forget cargo build")).toContain("Forgot");
  expect([...store.sessionPrefixes]).toEqual([]);
  const saved = JSON.parse(await readFile(path.join(context.stateDirectory, "sandbox.json"), "utf8"));
  expect(saved.prefixes).toEqual(["npm test"]);
  expect(saved.commands).toEqual([]);
});

test("/allowed forget all removes every kind, and says how many", async () => {
  const { say, store, context } = await filled();
  expect(await say("/allowed forget all")).toContain("Forgot all 5");
  expect(await store.allowsCommand("npm test")).toBe(false);
  expect(store.sessionPrefixes.size + store.sessionCommands.size).toBe(0);
  const saved = JSON.parse(await readFile(path.join(context.stateDirectory, "sandbox.json"), "utf8"));
  expect(saved.commands).toEqual([]);
  expect(saved.prefixes ?? []).toEqual([]);
  expect(await say("/allowed forget all")).toContain("Nothing is allowed");
});

test("forgetting something that is not saved says so plainly and changes nothing", async () => {
  const { say, store } = await filled();
  expect(await say("/allowed forget git push")).toContain("git push is not in your allowed list");
  await say("/allowed");
  const text = await say("/allowed forget 9");
  expect(text).toContain("There is no 9");
  expect(await store.allowsCommand("git log")).toBe(true);
  expect(await say("/allowed forget 0")).toContain("There is no 0");
});

test("a number is refused, and the list shown again, when the list changed since it was shown or was never shown", async () => {
  const { say, store } = await filled();
  const never = await say("/allowed forget 1");
  expect(never).toContain("Nothing was forgotten");
  expect(never).toMatch(/^\s+1\. git log/m);
  expect(await store.allowsCommand("git log")).toBe(true);
  await say("/allowed");
  await store.addPrefix("git commit");
  store.sessionCommands.add("ls-files-x");
  const changed = await say("/allowed forget 1");
  expect(changed).toContain("The list changed");
  expect(changed).toContain("Nothing was forgotten");
  expect(changed).toMatch(/^\s+\d+\. git commit/m);
  expect(await store.allowsCommand("git log")).toBe(true);
  // Having seen the new list, the number works.
  expect(await say("/allowed forget 1")).toContain("Forgot 1");
  expect(await store.allowsCommand("git log")).toBe(false);
});

test("anything else after /allowed is a plain usage error", async () => {
  const { store } = await fixture();
  await expect(allowedCommand("/allowed forget", store, () => {})).rejects.toThrow("Use /allowed or /allowed forget <number, command or all>.");
  await expect(allowedCommand("/allowed nope", store, () => {})).rejects.toThrow("Use /allowed");
});

test("the store's removePrefix, removeCommand and forgetAll say whether anything was there", async () => {
  const { store } = await fixture();
  await store.addPrefix("git log");
  await store.addCommand("make x");
  expect(await store.removePrefix("git push")).toBe(false);
  expect(await store.removePrefix("git log")).toBe(true);
  expect(await store.removeCommand("make x")).toBe(true);
  expect(await store.removeCommand("make x")).toBe(false);
  await store.addPrefix("a b"); await store.addCommand("c d");
  store.sessionCommands.add("e f");
  expect(await store.forgetAll()).toBe(3);
  expect(await store.forgetAll()).toBe(0);
});

function host(answers: Array<string | undefined>) {
  const asked: string[] = [];
  const value: SandboxHost = {
    canAsk: () => true,
    pick: async (question) => { asked.push(question); return answers.shift(); },
    write: () => {}, planning: () => false,
  };
  return { value, asked };
}

test("a command that was allowed asks again after you forget it, for always and for this session", async () => {
  const { home, project, context } = await fixture();
  const terminal = host(["Yes, always for this project", "Yes, for this session", "No", "No"]);
  const sandbox = createSessionSandbox(terminal.value, context, { root: () => project, home, seams: { engine: fakeEngine(), platform: "win32" } });
  const shell = runtimeShell(terminal.value, sandbox, new SandboxStore(context.stateDirectory));
  expect(await shell.approve!("cargo build")).toBeUndefined();
  expect(await shell.approve!("python3 tools/gen.py")).toBeUndefined();
  expect(await shell.approve!("cargo build --release")).toBeUndefined();
  expect(await shell.approve!("python3 tools/gen.py")).toBeUndefined();
  expect(terminal.asked).toHaveLength(2);
  const say = run(sandbox.store!);
  const listed = await say("/allowed");
  expect(listed).toContain("cargo build (and anything after it)");
  expect(listed).toContain("python3 tools/gen.py (this exact command) (this session)");
  await say("/allowed forget all");
  expect(await shell.approve!("cargo build")).toBe(SHELL_DECLINED);
  expect(await shell.approve!("python3 tools/gen.py")).toBe(SHELL_DECLINED);
  expect(terminal.asked).toHaveLength(4);
});

test("a file in the project cannot add or change what is allowed", async () => {
  const { project, context, store } = await fixture();
  await store.addPrefix("git log");
  for (const file of [".pi/sandbox.json", ".casper/sandbox.json", "sandbox.json"]) {
    await mkdir(path.dirname(path.join(project, file)), { recursive: true });
    await writeFile(path.join(project, file), JSON.stringify({ version: 1, hosts: [], commands: ["curl evil.example"], prefixes: ["curl", "rm"] }));
  }
  const fresh = new SandboxStore(context.stateDirectory);
  expect(await fresh.allowsCommand("curl evil.example")).toBe(false);
  expect(await fresh.allowsCommand("rm -rf x")).toBe(false);
  const text = await run(fresh)("/allowed");
  expect(text).toContain("git log");
  expect(text).not.toContain("curl");
  expect(text).not.toMatch(/\brm\b/);
  // The list is read from Casper's own folder only: forgetting never touches a project file.
  await run(fresh)("/allowed forget all");
  expect(JSON.parse(await readFile(path.join(project, ".pi/sandbox.json"), "utf8")).prefixes).toEqual(["curl", "rm"]);
});
