import { afterEach, expect, setDefaultTimeout } from "bun:test";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { formatNewProjectReceipt } from "../src/new/receipt";
import { createProject, missingToolMessage, tildePath } from "../src/new/scaffold";
import { makeNewFakes, type NewFakes } from "./support/new-fakes";
import { posixOnly, posixSymlinks } from "./support/platform";

setDefaultTimeout(30_000);

let fakes: NewFakes | undefined;
afterEach(async () => { await fakes?.cleanup(); fakes = undefined; });

const exists = (file: string) => lstat(file).then(() => true, () => false);

function gitLog(dir: string, env: NodeJS.ProcessEnv): string[] {
  try {
    return execFileSync("git", ["log", "--format=%s|%an"], { cwd: dir, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n").filter(Boolean);
  } catch { return []; }
}

posixOnly("runs uv init as-is, fills the template and makes one commit with the user's identity", async () => {
  fakes = await makeNewFakes();
  const env = fakes.env();
  const steps: string[] = [];
  const result = await createProject({ parent: fakes.parent, name: "mist-aps", template: "python-cli", env, homeDir: fakes.home, onStep: (line) => steps.push(line) });
  const dir = path.join(fakes.parent, "mist-aps");

  expect(await fakes.calls()).toContain("uv init --package --app --no-workspace --vcs none --name mist-aps .");
  expect(await fakes.calls()).toContain("uv add --dev pytest ruff");
  // Placeholders filled and __module__ renamed.
  const cli = await readFile(path.join(dir, "src/mist_aps/cli.py"), "utf8");
  expect(cli).toContain('prog="mist-aps"');
  expect(await readFile(path.join(dir, "tests/test_cli.py"), "utf8")).toContain("from mist_aps.cli import");
  expect(await exists(path.join(dir, "src/__module__"))).toBe(false);
  // Appended to the file uv wrote, not replacing it.
  const pyproject = await readFile(path.join(dir, "pyproject.toml"), "utf8");
  expect(pyproject).toContain('name = "mist-aps"');
  expect(pyproject).toContain("[tool.pytest.ini_options]");

  expect(result.status).toBe("ready");
  expect(result.exitCode).toBe(0);
  expect(result.checks.map((check) => `${check.name}:${check.status}`)).toEqual(["lint:pass", "test:pass"]);
  const log = gitLog(dir, env);
  expect(log).toHaveLength(1);
  expect(log[0]).toBe("Start mist-aps from Casper template python-cli v1|Test Person");
  expect(result.commit).toMatch(/^[0-9a-f]{7,}$/);
  expect(steps).toEqual(["  uv init …", "  Getting packages from pypi.org", "  adding pytest, ruff …", "  running lint …", "  running tests …", "  first commit …"]);
  expect(formatNewProjectReceipt(result)[0]).toBe(`Ready: ~/Projects/mist-aps · tests passed · first commit ${result.commit} (template python-cli v1)`);
});

posixOnly("a template file never overwrites what the init tool wrote unless it is listed in replace", async () => {
  fakes = await makeNewFakes();
  const result = await createProject({ parent: fakes.parent, name: "keep-me", template: "python-cli", env: fakes.env(), homeDir: fakes.home });
  const dir = path.join(fakes.parent, "keep-me");
  // .gitignore is not in replace: uv's copy stays.
  expect(await readFile(path.join(dir, ".gitignore"), "utf8")).toBe("FROM-UV\n");
  expect(result.kept).toEqual([".gitignore"]);
  // README.md and __init__.py are in replace: the template's copies win.
  expect(await readFile(path.join(dir, "README.md"), "utf8")).toContain("# keep-me");
  expect(await readFile(path.join(dir, "src/keep_me/__init__.py"), "utf8")).toContain("from .cli import main");
});

posixOnly("a folder that exists and isn't empty is refused and nothing is written", async () => {
  fakes = await makeNewFakes();
  const dir = path.join(fakes.parent, "taken");
  await mkdir(dir);
  await writeFile(path.join(dir, "notes.txt"), "mine\n");
  const result = await createProject({ parent: fakes.parent, name: "taken", template: "python-cli", env: fakes.env(), homeDir: fakes.home });
  expect(result.status).toBe("not_created");
  expect(result.exitCode).toBe(1);
  expect(result.reason).toBe("~/Projects/taken already exists and isn't empty. Pick another name.");
  expect(await readdir(dir)).toEqual(["notes.txt"]);
  expect((await fakes.calls()).some((call) => call.startsWith("uv init"))).toBe(false);
});

posixOnly("an existing empty folder is used", async () => {
  fakes = await makeNewFakes();
  await mkdir(path.join(fakes.parent, "empty-one"));
  const result = await createProject({ parent: fakes.parent, name: "empty-one", template: "python-cli", env: fakes.env(), homeDir: fakes.home });
  expect(result.status).toBe("ready");
});

posixSymlinks("a name that is a link is refused, even to an empty folder", async () => {
  fakes = await makeNewFakes();
  const outside = path.join(fakes.root, "outside");
  await mkdir(outside);
  await symlink(outside, path.join(fakes.parent, "linked"));
  const result = await createProject({ parent: fakes.parent, name: "linked", template: "python-cli", env: fakes.env(), homeDir: fakes.home });
  expect(result.status).toBe("not_created");
  expect(result.reason).toContain("is a link");
  expect(await readdir(outside)).toEqual([]);
});

posixOnly("without uv nothing is created and the message says where to get it", async () => {
  fakes = await makeNewFakes({ tools: ["bun"] });
  const result = await createProject({ parent: fakes.parent, name: "no-uv", template: "python-cli", env: fakes.env(), homeDir: fakes.home });
  expect(result.status).toBe("not_created");
  expect(result.reason).toBe(missingToolMessage("uv"));
  expect(result.reason).toBe("Casper needs uv to start a Python project and it isn't installed. Install it from https://docs.astral.sh/uv/ and run casper new again.");
  expect(await exists(path.join(fakes.parent, "no-uv"))).toBe(false);
});

posixOnly("bun init runs without BUN_OPTIONS, and the package name and scripts are set", async () => {
  fakes = await makeNewFakes();
  const result = await createProject({ parent: fakes.parent, name: "web-one", template: "web-app", env: fakes.env({ BUN_OPTIONS: "--smol", NODE_OPTIONS: "--inspect" }), homeDir: fakes.home });
  const initEnv = await fakes.savedEnv("bun-init");
  expect(initEnv.BUN_OPTIONS).toBeUndefined();
  expect(initEnv.NODE_OPTIONS).toBeUndefined();
  expect(await fakes.calls()).toContain("bun init --react -y");
  const pkg = JSON.parse(await readFile(path.join(fakes.parent, "web-one/package.json"), "utf8"));
  expect(pkg.name).toBe("web-one");
  expect(pkg.scripts).toEqual({ dev: "bun --hot src/index.ts", test: "bun test", typecheck: "tsc --noEmit" });
  expect(await exists(path.join(fakes.parent, "web-one/.casper/project.yaml"))).toBe(true);
  expect(result.status).toBe("ready");
  expect(result.checks.map((check) => check.name)).toEqual(["typecheck", "test"]);
  expect(result.checks[1]!.detail).toBe("2 tests");
});

posixOnly("an init tool that writes somewhere else is caught", async () => {
  fakes = await makeNewFakes();
  const result = await createProject({ parent: fakes.parent, name: "elsewhere", template: "web-app", env: fakes.env({ FAKE_WRITE_ELSEWHERE: "1" }), homeDir: fakes.home });
  expect(result.status).toBe("created");
  expect(result.exitCode).toBe(1);
  expect(result.reason).toBe("bun init didn't create package.json here.");
  expect(result.commit).toBeUndefined();
});

posixOnly("with no git identity nothing is committed and the message says how to set it", async () => {
  fakes = await makeNewFakes({ identity: false });
  const env = fakes.env();
  const result = await createProject({ parent: fakes.parent, name: "no-name", template: "python-cli", env, homeDir: fakes.home });
  expect(result.status).toBe("created");
  expect(result.exitCode).toBe(1);
  expect(result.reason).toBe("git doesn't know your name yet. Set it with: git config --global user.name \"Your Name\" and user.email, then run git commit.");
  expect(gitLog(path.join(fakes.parent, "no-name"), env)).toEqual([]);
  // Casper never sets an identity for you.
  expect(await readFile(fakes.gitconfig, "utf8")).toBe("");
  expect(formatNewProjectReceipt(result)[0]).toBe(`Created ~/Projects/no-name, not committed: ${result.reason}`);
});

posixOnly("a failing test means no commit and exit 1, with the output", async () => {
  fakes = await makeNewFakes();
  const env = fakes.env({ FAKE_TEST_FAIL: "1" });
  const result = await createProject({ parent: fakes.parent, name: "red", template: "python-cli", env, homeDir: fakes.home });
  expect(result.status).toBe("created");
  expect(result.exitCode).toBe(1);
  expect(result.reason).toBe("tests failed.");
  expect(result.output).toContain("1 failed");
  expect(gitLog(path.join(fakes.parent, "red"), env)).toEqual([]);
  const receipt = formatNewProjectReceipt(result);
  expect(receipt[0]).toBe("Created ~/Projects/red, not committed: tests failed.");
  expect(receipt).toContain("✓ lint passed · ✗ tests failed");
});

posixOnly("inside an existing git repository there is no git init and no commit", async () => {
  fakes = await makeNewFakes();
  const env = fakes.env();
  execFileSync("git", ["init", "-q", fakes.parent], { env });
  const result = await createProject({ parent: fakes.parent, name: "nested", template: "python-cli", env, homeDir: fakes.home });
  expect(await exists(path.join(fakes.parent, "nested/.git"))).toBe(false);
  expect(gitLog(fakes.parent, env)).toEqual([]);
  expect(result.status).toBe("created");
  expect(result.reason).toBe("it's inside the git repository at ~/Projects; commit it there when you're ready.");
});

posixOnly("offline: the folder keeps the template and the message says to run uv sync later", async () => {
  fakes = await makeNewFakes();
  const result = await createProject({ parent: fakes.parent, name: "offline", template: "python-cli", env: fakes.env({ FAKE_OFFLINE: "1" }), homeDir: fakes.home });
  expect(result.status).toBe("created");
  expect(result.notes).toEqual(["Couldn't get packages from pypi.org (offline?). The folder has the template but no packages; run uv sync when you're online."]);
  expect(await exists(path.join(fakes.parent, "offline/src/offline/cli.py"))).toBe(true);
});

posixOnly("init and checks never see AI provider keys, and checks never see tokens", async () => {
  fakes = await makeNewFakes();
  await createProject({
    parent: fakes.parent, name: "clean-env", template: "python-cli", homeDir: fakes.home,
    env: fakes.env({ OPENAI_API_KEY: "sk-test-provider", MIST_APITOKEN: "mist-secret", VIRTUAL_ENV: "/elsewhere", KEEP_ME: "yes" }),
  });
  const init = await fakes.savedEnv("uv-init");
  expect(init.OPENAI_API_KEY).toBeUndefined();
  expect(init.VIRTUAL_ENV).toBeUndefined();
  expect(init.KEEP_ME).toBe("yes");
  const run = await fakes.savedEnv("uv-run");
  expect(run.OPENAI_API_KEY).toBeUndefined();
  expect(run.MIST_APITOKEN).toBeUndefined();
  expect(run.KEEP_ME).toBe("yes");
});

posixOnly("stopping mid-way says so and makes no commit", async () => {
  fakes = await makeNewFakes();
  const env = fakes.env();
  const controller = new AbortController();
  const result = await createProject({
    parent: fakes.parent, name: "halted", template: "python-cli", env, homeDir: fakes.home, signal: controller.signal,
    onStep: (line) => { if (line.includes("adding")) controller.abort(); },
  });
  expect(result).toMatchObject({ status: "created", exitCode: 1, reason: "stopped before it finished." });
  expect(gitLog(path.join(fakes.parent, "halted"), env)).toEqual([]);
});

posixOnly("a bad name or an unknown template is a usage mistake and runs nothing", async () => {
  fakes = await makeNewFakes();
  const bad = await createProject({ parent: fakes.parent, name: "../x", template: "python-cli", env: fakes.env(), homeDir: fakes.home });
  expect(bad).toMatchObject({ status: "not_created", exitCode: 64, reason: "Names use lowercase letters, digits and dashes, like mist-aps." });
  const unknown = await createProject({ parent: fakes.parent, name: "fine", template: "nope", env: fakes.env(), homeDir: fakes.home });
  expect(unknown).toMatchObject({ status: "not_created", exitCode: 64 });
  expect(await fakes.calls()).toEqual([]);
  expect(await readdir(fakes.parent)).toEqual([]);
});

posixOnly("a .git that a package run made before git init: Casper runs no git there and says so", async () => {
  fakes = await makeNewFakes();
  const env = fakes.env({ FAKE_MAKE_GIT: "1" });
  const result = await createProject({ parent: fakes.parent, name: "odd-git", template: "python-cli", env, homeDir: fakes.home });
  expect(result.status).toBe("created");
  expect(result.exitCode).toBe(1);
  expect(result.reason).toBe("a .git folder appeared while packages were added, so Casper ran no git here. Look at it, then run git init and git commit yourself.");
  expect(result.commit).toBeUndefined();
  expect(gitLog(path.join(fakes.parent, "odd-git"), env)).toEqual([]);
});

posixSymlinks("a folder under a home reached through a link is still shown with ~, as git names it by its real path", async () => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-tilde-")));
  try {
    await mkdir(path.join(base, "real-home", "Projects"), { recursive: true });
    await symlink(path.join(base, "real-home"), path.join(base, "home"));
    const home = path.join(base, "home");
    expect(tildePath(path.join(base, "real-home", "Projects"), home)).toBe("~/Projects");
    expect(tildePath(path.join(home, "Projects"), home)).toBe("~/Projects");
    expect(tildePath(home, home)).toBe("~");
    expect(tildePath(path.join(base, "elsewhere"), home)).toBe(path.join(base, "elsewhere"));
  } finally { await rm(base, { recursive: true, force: true }); }
});
