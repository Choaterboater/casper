import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfiguration } from "../src/config/load";
import { discoverMCPConfiguration } from "../src/mcp/config";
import { discoverLSPConfiguration } from "../src/lsp/config";
import { discoverReferenceConfiguration } from "../src/references/config";
import { needsFifos } from "./support/platform";

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
