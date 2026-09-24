import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfiguration } from "../src/config/load";
import { discoverMCPConfiguration } from "../src/mcp/config";
import { discoverLSPConfiguration } from "../src/lsp/config";
import { discoverReferenceConfiguration } from "../src/references/config";
import { needsFifos, needsSymlinks } from "./support/platform";

test("profile selections reject traversal and malformed values at every precedence layer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-profile-review-"));
  const homeDir = path.join(root, "home");
  const projectRoot = path.join(root, "repo");
  const previous = process.env.CASPER_PROFILE;
  try {
    delete process.env.CASPER_PROFILE;
    await mkdir(path.join(homeDir, ".casper"), { recursive: true });
    await mkdir(path.join(projectRoot, ".casper"), { recursive: true });
    await Bun.write(path.join(homeDir, "evil/rules.md"), "INJECTED");
    await Bun.write(path.join(homeDir, "evil/config.yaml"), "skills: { maxActive: 0 }");
    for (const value of ["../../evil", "../x", "/tmp/x", "x\\y", ".", "..", "_work", "-work", ".work", "a".repeat(65), "", " work ", "work\n", "wörk", null, 12, ["work"], { name: "work" }]) {
      for (const layer of ["project", "global"] as const) {
        const file = layer === "project" ? path.join(projectRoot, ".casper/project.yaml") : path.join(homeDir, ".casper/config.yaml");
        await Bun.write(file, JSON.stringify({ profile: value }));
        await expect(loadConfiguration({ projectRoot, homeDir })).rejects.toThrow("Invalid profile name");
        // A higher-priority valid selection must not conceal invalid configuration.
        await expect(loadConfiguration({ projectRoot, homeDir, profileName: "work" })).rejects.toThrow("Invalid profile name");
        await Bun.write(file, "{}");
      }
      if (typeof value === "string") {
        await expect(loadConfiguration({ projectRoot, homeDir, profileName: value })).rejects.toThrow("Invalid profile name");
        process.env.CASPER_PROFILE = value;
        await expect(loadConfiguration({ projectRoot, homeDir, profileName: "work" })).rejects.toThrow("Invalid profile name");
        delete process.env.CASPER_PROFILE;
      }
    }
    expect((await loadConfiguration({ projectRoot, homeDir })).profileName).toBe("default");
  } finally {
    if (previous === undefined) delete process.env.CASPER_PROFILE;
    else process.env.CASPER_PROFILE = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("all four loaders agree on profile names and load the same valid profile", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-profile-discovery-"));
  const previous = process.env.CASPER_PROFILE;
  try {
    delete process.env.CASPER_PROFILE;
    const options = { homeDir: root, projectRoot: path.join(root, "repo") };
    for (const profileName of ["work", "Work_2.dev-3", "a".repeat(64), "_work", "-work", ".work", "a".repeat(65)]) {
      const valid = ["work", "Work_2.dev-3", "a".repeat(64)].includes(profileName);
      const dir = path.join(root, ".casper/profiles", profileName);
      await Bun.write(path.join(dir, "config.yaml"), "skills: { maxActive: 2 }");
      await Bun.write(path.join(dir, "rules.md"), profileName);
      await Bun.write(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: { marker: { command: "not-executed" } } }));
      await Bun.write(path.join(dir, "lsp.json"), JSON.stringify({ lspServers: { marker: { command: "not-executed", languages: { ".ts": "typescript" } } } }));
      await Bun.write(path.join(dir, "references.yaml"), JSON.stringify({ references: { marker: { path: root, paths: ["."] } } }));
      await Bun.write(path.join(options.projectRoot, ".casper/project.yaml"), JSON.stringify({ profile: profileName }));
      if (valid) {
        const config = await loadConfiguration(options);
        expect(config.profileName).toBe(profileName);
        expect(config.profileRules).toBe(profileName);
        expect(config.skills.maxActive).toBe(2);
      } else {
        await expect(loadConfiguration(options)).rejects.toThrow("Invalid profile name");
      }
      const selected = { ...options, profileName };
      const mcp = await discoverMCPConfiguration(selected);
      const lsp = await discoverLSPConfiguration(selected);
      const references = await discoverReferenceConfiguration(selected);
      expect(mcp.servers.map((server) => server.source)).toEqual(valid ? [path.join(dir, "mcp.json")] : []);
      expect(lsp.servers.map((server) => server.source)).toEqual(valid ? [path.join(dir, "lsp.json")] : []);
      expect(references.sources.map((source) => source.configuration)).toEqual(valid ? [path.join(dir, "references.yaml")] : []);
    }
  } finally {
    if (previous === undefined) delete process.env.CASPER_PROFILE;
    else process.env.CASPER_PROFILE = previous;
    await rm(root, { recursive: true, force: true });
  }
});

for (const kind of ["mcp", "lsp"] as const) {
needsFifos(`${kind} discovery rejects a project FIFO without blocking startup`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "casper-config-review-"));
    try {
      await mkdir(path.join(root, ".casper"));
      const fifo = Bun.spawn(["mkfifo", path.join(root, ".casper", `${kind}.json`)], { stdout: "ignore", stderr: "pipe" });
      expect(await fifo.exited).toBe(0);
      const name = kind === "mcp" ? "discoverMCPConfiguration" : "discoverLSPConfiguration";
      const child = Bun.spawn([process.execPath, "-e", `
        import { ${name} as discover } from ${JSON.stringify(path.resolve(`src/${kind}/config.ts`))};
        const result = await discover({ projectRoot: process.argv[1], homeDir: process.argv[1] + "/home" });
        console.log(JSON.stringify(result));
      `, root], { stdout: "pipe", stderr: "pipe" });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 1000);
      try {
        const exitCode = await child.exited;
        expect(timedOut).toBe(false);
        expect(exitCode).toBe(0);
        const result = JSON.parse(await new Response(child.stdout).text());
        expect(result.servers).toEqual([]);
        expect(result.diagnostics).toHaveLength(1);
        expect(result.diagnostics[0]).toContain(`Cannot read ${kind.toUpperCase()} configuration`);
      } finally { clearTimeout(timer); child.kill(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

needsSymlinks("project rules and project.yaml are never read through a symlink leaving the project", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-config-review-"));
  try {
    const project = path.join(root, "project"); const outside = path.join(root, "outside");
    await mkdir(path.join(project, ".casper"), { recursive: true }); await mkdir(outside);
    await writeFile(path.join(outside, "secret.txt"), "OUTSIDE_SECRET_MUST_NOT_LOAD");
    await writeFile(path.join(outside, "project.yaml"), "commands:\n  test: OUTSIDE_SECRET_MUST_NOT_LOAD\n");
    const load = () => loadConfiguration({ projectRoot: project, homeDir: path.join(root, "home") });

    await symlink(path.join(outside, "secret.txt"), path.join(project, ".casper/rules.md"));
    await expect(load()).rejects.toThrow(".casper/rules.md resolves outside the project");
    await rm(path.join(project, ".casper/rules.md"));

    await symlink(path.join(outside, "project.yaml"), path.join(project, ".casper/project.yaml"));
    await expect(load()).rejects.toThrow(".casper/project.yaml resolves outside the project");
    await rm(path.join(project, ".casper"), { recursive: true });

    // The whole .casper directory redirected outside is the same escape.
    await writeFile(path.join(outside, "rules.md"), "OUTSIDE_SECRET_MUST_NOT_LOAD");
    await symlink(outside, path.join(project, ".casper"));
    await expect(load()).rejects.toThrow("resolves outside the project");
    await rm(path.join(project, ".casper"));

    // A link that stays inside the repository is an ordinary file.
    await mkdir(path.join(project, ".casper")); await mkdir(path.join(project, "docs"));
    await writeFile(path.join(project, "docs/rules.md"), "In-repo rules.");
    await symlink(path.join("..", "docs/rules.md"), path.join(project, ".casper/rules.md"));
    expect((await load()).projectRules).toBe("In-repo rules.");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("oversized project rules are refused instead of being sent with every prompt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-config-review-"));
  try {
    await mkdir(path.join(root, ".casper"));
    await writeFile(path.join(root, ".casper/rules.md"), "x".repeat(64 * 1024 + 1));
    await expect(loadConfiguration({ projectRoot: root, homeDir: path.join(root, "home") })).rejects.toThrow("Cannot read .casper/rules.md: file exceeds 65536 bytes");
  } finally { await rm(root, { recursive: true, force: true }); }
});

needsFifos("a project.yaml FIFO fails visibly without blocking startup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-config-review-"));
  try {
    await mkdir(path.join(root, ".casper"));
    expect(Bun.spawnSync(["mkfifo", path.join(root, ".casper/project.yaml")]).exitCode).toBe(0);
    const child = Bun.spawn([process.execPath, "-e", `
      import { loadConfiguration } from ${JSON.stringify(path.resolve("src/config/load.ts"))};
      await loadConfiguration({ projectRoot: process.argv[1], homeDir: process.argv[1] + "/home" }).catch((error) => console.log(error.message));
    `, root], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
    try {
      expect(await child.exited).toBe(0);
      expect(await new Response(child.stdout).text()).toContain("Cannot read .casper/project.yaml: not a regular file");
    } finally { clearTimeout(timer); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a mistyped policy value fails naming the file, the key and the allowed values", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-config-review-"));
  try {
    const home = path.join(root, "home");
    await mkdir(path.join(home, ".casper"), { recursive: true });
    await mkdir(path.join(root, ".casper"));
    const load = () => loadConfiguration({ projectRoot: root, homeDir: home });
    const cases: Array<[string, string, string]> = [
      ["global", "git:\n  push: nevr\n", "Invalid ~/.casper/config.yaml: git.push must be never or neverUnlessRequested"],
      ["global", "policy:\n  behavior:\n    autonomy: lwo\n", "Invalid ~/.casper/config.yaml: behavior.autonomy must be low, medium or high"],
      ["global", "behavior:\n  askQuestions: always\n", "behavior.askQuestions must be beforeChanges or onlyWhenBlocked"],
      ["global", "git:\n  confirmDestructive: \"false\"\n", "git.confirmDestructive must be true or false"],
      ["project", "code:\n  preferSmallChanges: yes please\n", "Invalid .casper/project.yaml: code.preferSmallChanges must be true or false"],
      ["project", "workspace:\n  isolateWhen:\n    riskyRefactor: 1\n", "workspace.isolateWhen.riskyRefactor must be true or false"],
      ["project", "behavior: high\n", "Invalid .casper/project.yaml: behavior must be a mapping"],
    ];
    for (const [layer, yaml, message] of cases) {
      const file = layer === "global" ? path.join(home, ".casper/config.yaml") : path.join(root, ".casper/project.yaml");
      await writeFile(file, yaml);
      await expect(load()).rejects.toThrow(message);
      await rm(file);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unknown top-level and policy-section keys are reported as warnings, not silently dropped", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-config-review-"));
  try {
    const home = path.join(root, "home");
    await mkdir(path.join(home, ".casper/profiles/work"), { recursive: true });
    await mkdir(path.join(root, ".casper"));
    await writeFile(path.join(home, ".casper/config.yaml"), "profile: work\npolicy:\n  behaviour:\n    askQuestions: beforeChanges\n");
    await writeFile(path.join(home, ".casper/profiles/work/config.yaml"), "git:\n  pushh: never\n");
    await writeFile(path.join(root, ".casper/project.yaml"), "skils:\n  maxActive: 2\nbehavior:\n  autonomy: low\n  inspectFirst: true\n");
    const configuration = await loadConfiguration({ projectRoot: root, homeDir: home });
    expect(configuration.warnings).toEqual([
      "~/.casper/config.yaml: unknown key policy.behaviour (ignored)",
      "profile work config.yaml: unknown key git.pushh (ignored)",
      ".casper/project.yaml: unknown key skils (ignored)",
      ".casper/project.yaml: unknown key behavior.inspectFirst (ignored)",
    ]);
    expect(configuration.policy.behavior.autonomy).toBe("low");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Casper shows configuration warnings at startup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-config-review-"));
  try {
    await mkdir(path.join(root, ".casper"));
    await writeFile(path.join(root, ".casper/project.yaml"), "skils:\n  maxActive: 2\n\"x\\e]0;T\\a\": 1\n");
    const { PI_CODING_AGENT_DIR: _dir, ...inherited } = process.env;
    const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../src/cli.ts"), "/project"], {
      cwd: root, env: { ...inherited, HOME: root, CASPER_PROFILE: "default" }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(code).toBe(0);
    expect(stdout).toContain("[config] .casper/project.yaml: unknown key skils (ignored)");
    expect(stdout).toContain("[config] .casper/project.yaml: unknown key x");
    expect(stdout).not.toContain("\x1b]");
  } finally { await rm(root, { recursive: true, force: true }); }
});
