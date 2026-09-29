import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanToolText, compareVersions, parseAnsibleLint, parseGitleaks, parseMcpScanner, parseOsv, parseRuff, parseSemgrep, parseZizmor, semgrepRuleId } from "../src/security/parse";
import { formatSecurityReport, securityReportJson } from "../src/security/format";
import type { SecurityReport } from "../src/security/run";

// Real reports captured from the pinned versions (gitleaks 8.30.1, ruff 0.16.9, semgrep 1.178.0,
// zizmor 1.30.1, osv-scanner 2.6.0, ansible-lint 26.9.0, cisco-ai-mcp-scanner 4.8.4) run on
// tests/fixtures/security-tools/setup.ts fixtureRepo in /work/repo, offline with an empty env.
const outputs = path.join(import.meta.dir, "fixtures", "security-outputs");
const read = (name: string) => readFileSync(path.join(outputs, name), "utf8");
const context = { root: "/work/repo" };

test("gitleaks findings keep file:line and rule, never the secret value", () => {
  const withSecret = JSON.stringify(JSON.parse(read("gitleaks.json")).map((item: Record<string, unknown>) => ({ ...item, Secret: "ghp_realSecretValue123456", Match: "GITHUB_TOKEN = \"ghp_realSecretValue123456\"" })));
  const findings = parseGitleaks(withSecret, context);
  expect(findings).toEqual([{ tool: "gitleaks", file: "app/server.py", line: 8, rule: "github-pat", severity: "high", text: "looks like a secret (github-pat, value hidden)" }]);
  const report: SecurityReport = {
    target: { name: "repo", path: "/work/repo" }, tools: [{ id: "gitleaks", label: "gitleaks", status: "problems", text: "", problems: 1, notes: 0 }],
    findings, ignores: { committed: 0, approved: 0, new: [], unknown: [] }, ignoreFiles: [], missing: [], problems: 1, notes: 0, notRun: 0, exitCode: 1,
  };
  expect(formatSecurityReport(report)).not.toContain("realSecretValue");
  expect(JSON.stringify(securityReportJson(report))).not.toContain("realSecretValue");
});

test("ruff S findings map to file:line with the statement's end line", () => {
  const findings = parseRuff(read("ruff.json"), context);
  expect(findings.map((finding) => `${finding.file}:${finding.line}${finding.endLine ? `-${finding.endLine}` : ""} ${finding.rule}`)).toEqual([
    "app/server.py:8 S105", "app/server.py:13 S602", "app/server.py:17 S324", "app/server.py:22-23 S608", "app/server.py:28 S608",
  ]);
  expect(findings[0]!.text).toBe("Possible hardcoded password assigned to: \"GITHUB_TOKEN\"");
});

test("semgrep's path-derived rule prefix is stripped", () => {
  expect(semgrepRuleId("home.user.casper..claude.src.security.rules.casper.mcp-tool-shell-from-input")).toBe("casper.mcp-tool-shell-from-input");
  expect(semgrepRuleId("tmp.casper-security-abc.casper.yaml-load-unsafe")).toBe("casper.yaml-load-unsafe");
  expect(parseSemgrep(read("semgrep.json"), context)).toEqual([{
    tool: "semgrep", file: "app/server.py", line: 13, rule: "casper.mcp-tool-shell-from-input", severity: "high",
    text: "A tool argument goes into a shell command, eval or exec. A caller can run any command.",
  }]);
});

test("zizmor rows are 0-based and become 1-based lines", () => {
  const findings = parseZizmor(read("zizmor.json"), context);
  expect(findings.map((finding) => `${finding.file}:${finding.line} ${finding.rule} ${finding.severity}`).sort()).toEqual([
    ".github/workflows/ci.yml:10 template-injection high",
    ".github/workflows/ci.yml:6 excessive-permissions medium",
    ".github/workflows/ci.yml:9 artipacked medium",
    ".github/workflows/ci.yml:9 unpinned-uses high",
  ]);
});

test("osv-scanner gives one finding per package, on its lockfile line, with the version that fixes all", () => {
  const findings = parseOsv(read("osv-scanner.json"), { root: "/work/repo", readText: () => "jinja2==2.4.1\nrequests==2.19.0\n" });
  expect(findings.map((finding) => [finding.file, finding.line, finding.key, finding.severity])).toEqual([
    ["requirements.txt", 1, "jinja2@2.4.1", "high"], ["requirements.txt", 2, "requests@2.19.0", "high"],
  ]);
  expect(findings[0]!.text).toBe("jinja2 2.4.1 has 9 known advisories (GHSA-8r7q-cvjq-x353, GHSA-fqh9-2qgg-h84h, GHSA-462w-v97r-4m45 and 6 more); 3.1.6 fixes all of them");
  expect(compareVersions("2.10.1", "2.9")).toBeGreaterThan(0);
});

test("ansible-lint keeps only security rules; style rules are dropped", () => {
  const findings = parseAnsibleLint(read("ansible-lint.json"), context);
  expect(findings.map((finding) => [finding.rule, finding.line, finding.severity])).toEqual([["command-instead-of-module", 3, "low"], ["risky-shell-pipe", 3, "medium"]]);
});

test("mcp-scanner results are keyed by tool name, not file:line", () => {
  const findings = parseMcpScanner(read("mcp-scanner.json"), { root: "/work/repo", toolsFile: "/work/repo/tools.json" });
  expect(findings).toEqual([{ tool: "mcp-scanner", file: "tools.json", line: 0, key: "get_weather", rule: "credential-harvesting", severity: "high", text: "tool \"get_weather\": credential harvesting in its description" }]);
});

test("a malformed report throws (the tool is then 'not run', never 'ok')", () => {
  expect(() => parseRuff("not json", context)).toThrow();
  expect(() => parseSemgrep("", context)).toThrow();
  expect(() => parseZizmor("{\"a\":1}", context)).toThrow();
});

test("tool text is escaped and value-shaped text is hidden", () => {
  expect(cleanToolText("bad \u001b[31mred")).not.toContain("\u001b");
  expect(cleanToolText("password = hunter2secret")).not.toContain("hunter2secret");
  expect(cleanToolText("found ghp_abcdefghijklmnop123")).not.toContain("ghp_abcdefghijklmnop123");
  expect(cleanToolText("Possible hardcoded password assigned to: \"X\"")).toBe("Possible hardcoded password assigned to: \"X\"");
});
