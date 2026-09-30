import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfiguration } from "../src/config/load";
import { PRIVATE_PATHS, PROTECTED_WRITE_PATHS } from "../src/platform/project-paths";
import { cachePaths, hostListed, REGISTRY_HOSTS, sandboxPolicy } from "../src/sandbox/policy";
import { SandboxStore } from "../src/sandbox/store";
import { posixOnly } from "./support/platform";

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
  const policy = sandboxPolicy({ root, home, tempDirs: ["/tmp-fixture"], platform: "linux" });
  for (const entry of PRIVATE_PATHS) expect(policy.denyRead).toContain(path.join(home, entry));
  expect(policy.denyRead).toContain(path.join(home, ".casper", "projects"));
  expect(policy.allowWrite).toEqual([root, "/tmp-fixture", ...cachePaths("linux").map((entry) => path.join(home, entry))]);
  for (const name of ["hooks", "config", "config.worktree"]) expect(policy.denyWrite).toContain(path.join(root, ".git", name));
  for (const entry of PROTECTED_WRITE_PATHS) expect(policy.denyWrite).toContain(path.join(home, entry));
  expect(policy.allowedDomains).toEqual(expect.arrayContaining([...REGISTRY_HOSTS, "localhost"]));
});

test("a plan turn's policy leaves the project read-only", async () => {
  const { home, root } = await fixture();
  const policy = sandboxPolicy({ root, home, tempDirs: ["/tmp-fixture"], platform: "linux", readOnlyProject: true });
  expect(policy.allowWrite).not.toContain(root);
  expect(policy.allowWrite).toContain("/tmp-fixture");
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

test("a commondir a command writes into the project's .git is removed at once and said; one you had stays", async () => {
  const { ShellSandbox } = await import("../src/sandbox/manager");
  const { passThroughEngine } = await import("../src/sandbox/runtime");
  const { home, root } = await fixture();
  const notes: string[] = [];
  const sandbox = new ShellSandbox({ root: () => root, home, tempDirs: [], platform: "linux", engine: passThroughEngine(), problem: () => undefined, note: (line) => notes.push(line) });
  await sandbox.wrap("true", { cwd: root });
  const pointer = path.join(root, ".git", "commondir");
  await writeFile(pointer, "../elsewhere\n");
  for (let attempt = 0; attempt < 100 && await stat(pointer).then(() => true, () => false); attempt++) await Bun.sleep(20);
  expect(await stat(pointer).then(() => true, () => false)).toBe(false);
  expect(notes).toEqual([`[sandbox] Removed ${pointer}: a command wrote it, and it would point git at another folder's settings and hooks.`]);
  await sandbox.close();

  const { root: yours, home: home2 } = await fixture();
  await writeFile(path.join(yours, ".git", "commondir"), "../mine\n");
  const kept = new ShellSandbox({ root: () => yours, home: home2, tempDirs: [], platform: "linux", engine: passThroughEngine(), problem: () => undefined });
  await kept.wrap("true", { cwd: yours });
  await kept.close();
  expect(await stat(path.join(yours, ".git", "commondir")).then(() => true, () => false)).toBe(true);
});
