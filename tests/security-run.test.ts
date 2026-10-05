import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { formatResultLine, formatSecurityHeader, formatSecurityReport, SECURITY_OFFLINE_LINE, securityNetworkLine, securityReportJson } from "../src/security/format";
import { MCP_NEEDS_TOOLS, OSV_NO_DATA, SecurityCheck } from "../src/security/run";
import { fakeTools, fixtureRepo, SEMGREP_NOT_ON_WINDOWS, SEMGREP_RUNS } from "./fixtures/security-tools/setup";

const temps: string[] = [];
afterEach(async () => { for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

async function withOsvData(home: string, daysOld: number, now: Date): Promise<void> {
  const dir = path.join(home, ".casper", "security", "osv-db", "osv-scalibr", "PyPI");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "all.zip"), "");
  const when = new Date(now.getTime() - daysOld * 86_400_000);
  await utimes(path.join(dir, "all.zip"), when, when);
}

test("one tool crashing, hanging or printing garbage leaves the others' results intact", async () => {
  const root = await fixtureRepo("casper-security-run-");
  temps.push(root);
  const home = await temp("casper-security-run-home-");
  await withOsvData(home, 1, new Date());
  const tools = await fakeTools(home, { gitleaks: "crash", ruff: "hang", semgrep: "garbage" });
  const started = Date.now();
  const report = await new SecurityCheck({ root, homeDir: home, find: tools.find, timeouts: { ruff: 1500 } }).run();
  expect(Date.now() - started).toBeLessThan(20_000);
  const byId = Object.fromEntries(report.tools.map((tool) => [tool.id, tool]));
  expect(byId.gitleaks).toMatchObject({ status: "not-run", text: "ended with exit code 3: panic: something broke inside the tool" });
  expect(byId.ruff).toMatchObject({ status: "not-run", text: "took longer than 2 seconds; stopped" });
  expect(byId.semgrep!.status).toBe("not-run");
  expect(byId.semgrep!.text).toStartWith(SEMGREP_RUNS ? "its report could not be read" : SEMGREP_NOT_ON_WINDOWS);
  expect(byId.zizmor!.status).toBe("problems");
  expect(byId["osv-scanner"]!.status).toBe("problems");
  expect(byId["ansible-lint"]!.status).toBe("problems");
  expect(report.notRun).toBe(3);
  expect(report.findings.some((finding) => finding.tool === "zizmor")).toBe(true);
  expect(report.exitCode).toBe(1);
  expect(formatResultLine(report)).toBe(`Result: ${report.problems} problems, 1 note, 3 checks not run. This is what these tools found. It does not prove the code has no problems.`);
}, 90_000);

test("Casper's own words never call the code safe or secure, even with nothing found", async () => {
  const root = await fixtureRepo("casper-security-clean-");
  temps.push(root);
  const home = await temp("casper-security-run-home-");
  await withOsvData(home, 0, new Date());
  const tools = await fakeTools(home, { gitleaks: "clean", ruff: "clean", semgrep: "clean", zizmor: "clean", "osv-scanner": "clean", "ansible-lint": "clean", "mcp-scanner": "clean" });
  const report = await new SecurityCheck({ root, homeDir: home, find: tools.find, mcpScanner: true, mcpToolsJson: path.join(root, "tools.json") }).run();
  expect(report.tools.every((tool) => tool.status === "ok" || (!SEMGREP_RUNS && tool.id === "semgrep"))).toBe(true);
  expect(report.exitCode).toBe(0);
  const text = formatSecurityReport(report);
  const json = JSON.stringify(securityReportJson(report));
  for (const output of [text, json]) {
    expect(output).not.toMatch(/\bsafe\b/i);
    expect(output).not.toMatch(/\bsecure\b/i);
    // Casper can't keep a tool off the network yet, so its own words never say "offline".
    expect(output).not.toMatch(/\boffline\b/i);
  }
  expect(text).toContain(`Result: 0 problems${SEMGREP_RUNS ? "" : ", 1 check not run"}. This is what these tools found. It does not prove the code has no problems.`);
  expect(text).toContain("zizmor        ok           its online checks off");
});

test("the header says what holds the tools here: no network only where the sandbox enforces it", () => {
  expect(formatSecurityHeader({ name: "hpe-mcp", path: "/src/hpe-mcp" })).toBe(`Security check: hpe-mcp (/src/hpe-mcp)\n${securityNetworkLine()}\n`);
  expect(securityNetworkLine({ on: true, platform: "linux", state: { kind: "on" }, failure: undefined }))
    .toBe("Casper runs these tools in the shell sandbox: no network, no passwords or tokens, and no writes outside the project, temp and package caches.");
  // macOS cuts a tool's network in its own profile too (src/sandbox/runtime.ts withoutNetwork).
  expect(securityNetworkLine({ on: true, platform: "darwin", state: { kind: "on" }, failure: undefined }))
    .toBe(securityNetworkLine({ on: true, platform: "linux", state: { kind: "on" }, failure: undefined }));
  const windows = securityNetworkLine({ on: false, platform: "win32", state: { kind: "unsupported", reason: "Windows" }, failure: undefined });
  expect(windows).toBe(`${SECURITY_OFFLINE_LINE} Nothing blocks their network here (Windows).`);
  for (const line of [windows, securityNetworkLine(null)]) expect(line).not.toMatch(/offline|no network/i);
});

test("--strict also fails on a check that did not run; --json has the versioned shape", async () => {
  const root = await fixtureRepo("casper-security-strict-");
  temps.push(root);
  const home = await temp("casper-security-run-home-");
  const tools = await fakeTools(home, { gitleaks: "clean", ruff: "clean", semgrep: "clean", zizmor: "clean", "ansible-lint": "clean" });
  const relaxed = await new SecurityCheck({ root, homeDir: home, find: tools.find }).run();
  expect(relaxed.tools.find((tool) => tool.id === "osv-scanner")).toMatchObject({ status: "not-run", text: OSV_NO_DATA });
  expect(relaxed.exitCode).toBe(0);
  const strict = await new SecurityCheck({ root, homeDir: home, find: tools.find, strict: true }).run();
  expect(strict.exitCode).toBe(1);
  const json = securityReportJson(strict);
  expect(Object.keys(json)).toEqual(["version", "target", "tools", "findings", "ignores", "ignoreFiles", "notRun", "problems", "notes", "exitCode"]);
  expect(json.notRun).toEqual([...SEMGREP_RUNS ? [] : [{ id: "semgrep", reason: SEMGREP_NOT_ON_WINDOWS }], { id: "osv-scanner", reason: OSV_NO_DATA }]);
});

test("mcp-scanner is off unless turned on, and needs the server's tool list", async () => {
  const root = await fixtureRepo("casper-security-mcp-");
  temps.push(root);
  const home = await temp("casper-security-run-home-");
  const tools = await fakeTools(home, { gitleaks: "clean", ruff: "clean", semgrep: "clean", zizmor: "clean", "ansible-lint": "clean", "mcp-scanner": "canned" });
  const off = await new SecurityCheck({ root, homeDir: home, find: tools.find, only: ["mcp-scanner"] }).run();
  expect(off.tools).toEqual([expect.objectContaining({ id: "mcp-scanner", status: "off" })]);
  expect(await tools.recorded("mcp-scanner")).toBeUndefined();
  const noList = await new SecurityCheck({ root, homeDir: home, find: tools.find, only: ["mcp-scanner"], mcpScanner: true }).run();
  expect(noList.tools[0]).toMatchObject({ status: "not-run", text: MCP_NEEDS_TOOLS });
  const on = await new SecurityCheck({ root, homeDir: home, find: tools.find, only: ["mcp-scanner"], mcpScanner: true, mcpToolsJson: path.join(root, "tools.json") }).run();
  expect(on.findings).toEqual([expect.objectContaining({ tool: "mcp-scanner", key: "get_weather", severity: "high" })]);
  expect(formatSecurityReport(on)).toContain("mcp-scanner   1 problem    tools.json  tool \"get_weather\": credential harvesting in its description [credential-harvesting]");
});
