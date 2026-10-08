import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEAD_PROXY } from "../src/mcp/check/sandbox";
import { SecurityCheck, type SecurityReport } from "../src/security/run";
import { RUFF_SECURITY_RULES, toolArgs } from "../src/security/tools";
import { fakeTools, fixtureRepo, SEMGREP_RUNS } from "./fixtures/security-tools/setup";
import { removeTempDir } from "./support/temp-dir";

let root: string;
let home: string;
let tools: Awaited<ReturnType<typeof fakeTools>>;
let report: SecurityReport;

beforeAll(async () => {
  root = await fixtureRepo("casper-security-args-");
  home = await mkdtemp(path.join(os.tmpdir(), "casper-security-args-home-"));
  tools = await fakeTools(home);
  // osv-scanner runs only with advisory data present.
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(path.join(home, ".casper", "security", "osv-db", "osv-scalibr", "PyPI"), { recursive: true });
  await writeFile(path.join(home, ".casper", "security", "osv-db", "osv-scalibr", "PyPI", "all.zip"), "");
  report = await new SecurityCheck({
    root, homeDir: home, find: tools.find, mcpScanner: true, mcpToolsJson: path.join(root, "tools.json"),
    baseEnv: { PATH: process.env.PATH, MIST_APITOKEN: "abc123", CENTRAL_CLIENT_ID: "cid", HTTPS_PROXY: "http://corp:8080" },
  }).run();
});
afterAll(async () => { await removeTempDir(root); await removeTempDir(home); });

test("every tool ran with its offline flags and with its own inline ignores turned off", async () => {
  expect(report.tools.map((tool) => [tool.id, tool.status])).toEqual([
    ["gitleaks", "problems"], ["ruff", "problems"], ["semgrep", SEMGREP_RUNS ? "problems" : "not-run"], ["zizmor", "problems"],
    ["osv-scanner", "problems"], ["ansible-lint", "problems"], ["mcp-scanner", "problems"],
  ]);
  const gitleaks = (await tools.recorded("gitleaks"))!.args;
  expect(gitleaks).toContain("--redact");
  expect(gitleaks).toContain("--ignore-gitleaks-allow");
  // No committed .gitleaks.toml: Casper's default-rules config, never the repo's.
  expect(gitleaks[gitleaks.indexOf("--config") + 1]).toMatch(/gitleaks-default\.toml$/);

  if (SEMGREP_RUNS) {
    const semgrep = (await tools.recorded("semgrep"))!.args;
    expect(semgrep).toContain("--metrics=off");
    expect(semgrep).toContain("--disable-nosem");
    expect(semgrep).toContain("--disable-version-check");
    const configs = semgrep.filter((_, index) => semgrep[index - 1] === "--config");
    expect(configs.length).toBeGreaterThan(0);
    for (const config of configs) {
      expect(config).not.toBe("auto");
      expect(config).not.toMatch(/^(p|r)\//);
      expect(path.isAbsolute(config)).toBe(true);
    }
  } else {
    expect(await tools.recorded("semgrep")).toBeUndefined();
  }

  const zizmor = (await tools.recorded("zizmor"))!.args;
  expect(zizmor).toContain("--offline");
  expect(zizmor).toContain("--no-ignores");
  expect(zizmor).toContain("--no-config");

  const ruff = (await tools.recorded("ruff"))!.args;
  for (const flag of ["--isolated", "--ignore-noqa", "--no-cache"]) expect(ruff).toContain(flag);
  expect(ruff[ruff.indexOf("--select") + 1]).toBe(RUFF_SECURITY_RULES.join(","));

  const osv = (await tools.recorded("osv-scanner"))!;
  expect(osv.args).toContain("--offline");
  expect(osv.args).toContain("--no-call-analysis=all");
  expect(osv.env.OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY).toBe(path.join(home, ".casper", "security", "osv-db"));

  const lint = (await tools.recorded("ansible-lint"))!;
  expect(lint.args).toContain("--offline");
  // Casper's own ansible.cfg, never the repo's (a vault_password_file there is a script Ansible runs).
  expect(lint.env.ANSIBLE_CONFIG).toBeDefined();
  expect(lint.env.ANSIBLE_CONFIG!.startsWith(root) || lint.env.ANSIBLE_CONFIG!.startsWith(await realpath(root))).toBe(false);
  expect(path.basename(lint.env.ANSIBLE_CONFIG!)).toBe("ansible.cfg");
  const scanner = (await tools.recorded("mcp-scanner"))!.args;
  expect(scanner.slice(0, 2)).toEqual(["--analyzers", "yara"]);
  expect(scanner).toContain("static");
});

test("every tool ran in the repo with the clean env: no tokens, dead proxy", async () => {
  // The project's real folder: on macOS the temp folder is behind a link (/var is /private/var).
  const real = await realpath(root);
  for (const tool of report.tools.filter((tool) => tool.id !== "semgrep" || SEMGREP_RUNS)) {
    const seen = (await tools.recorded(tool.id))!;
    expect(seen.cwd).toBe(real);
    expect(seen.env.MIST_APITOKEN).toBeUndefined();
    expect(seen.env.CENTRAL_CLIENT_ID).toBeUndefined();
    expect(seen.env.HTTPS_PROXY).toBe(DEAD_PROXY);
    expect(seen.env.HOME).toBe(path.join(home, ".casper", "security", "home"));
  }
});

test("ansible-lint file names come after -- and a name starting with - gets ./, so it is never read as an option", () => {
  const args = toolArgs("ansible-lint", {
    root: "/repo", semgrepRules: [], gitleaksConfig: "", gitleaksIgnoreDir: "",
    ansibleTargets: ["site.yml", "--exclude=site.yml", "-x.yml"],
  });
  expect(args.slice(args.indexOf("--"))).toEqual(["--", "site.yml", "./--exclude=site.yml", "./-x.yml"]);
});
