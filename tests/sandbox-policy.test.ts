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
