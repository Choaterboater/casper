import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {  } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEAD_PROXY } from "../src/mcp/check/sandbox";
import { formatSecurityReport } from "../src/security/format";
import { findTool, osvDbState } from "../src/security/install";
import { SecurityCheck } from "../src/security/run";
import { SECURITY_TOOLS } from "../src/security/tools";
import { fixtureRepo } from "./fixtures/security-tools/setup";
import { removeTempDir } from "./support/temp-dir";

// Real pinned tools on a planted fixture, with a dead proxy and no tokens. Runs only in the CI job that
// installs Casper's pinned tools (SECURITY_TOOLS_REAL=1); SECURITY_TOOLS_HOME names the home folder
// that holds ~/.casper/tools. Never run by default: no downloads, no vendor calls in the normal suite.
const enabled = process.env.SECURITY_TOOLS_REAL === "1";
const home = process.env.SECURITY_TOOLS_HOME ?? os.homedir();
const temps: string[] = [];
afterAll(async () => { for (const dir of temps) await removeTempDir(dir); });

test.skipIf(!enabled)("semgrep --test passes on Casper's own rules, offline", async () => {
  const semgrep = await findTool(SECURITY_TOOLS.semgrep, { homeDir: home });
  expect(semgrep.kind).not.toBe("missing");
  if (semgrep.kind === "missing") return;
  const result = spawnSync(semgrep.path, ["--test", "--metrics=off", "--disable-version-check", path.join(import.meta.dir, "..", "src", "security", "rules")], {
    encoding: "utf8", env: { PATH: process.env.PATH, HOME: path.join(home, ".casper", "security", "home"), HTTPS_PROXY: DEAD_PROXY, HTTP_PROXY: DEAD_PROXY, SEMGREP_SEND_METRICS: "off" },
  });
  expect(`${result.stdout}${result.stderr}`).toContain("All tests passed");
  expect(result.status).toBe(0);
}, 300_000);

test.skipIf(!enabled)("each pinned tool finds its planted issue with a dead proxy and an empty env", async () => {
  const root = await fixtureRepo("casper-security-real-");
  temps.push(root);
  const report = await new SecurityCheck({
    root, homeDir: home, mcpScanner: true, mcpToolsJson: path.join(root, "tools.json"),
    baseEnv: { PATH: process.env.PATH, LANG: "C.UTF-8", MIST_APITOKEN: "abc123" },
  }).run();
  const text = formatSecurityReport(report);
  const byTool = (id: string) => report.findings.filter((finding) => finding.tool === id).map((finding) => `${finding.file}:${finding.line} ${finding.rule}`);
  expect(report.tools.filter((tool) => tool.status === "not-run" && tool.id !== "osv-scanner")).toEqual([]);
  expect(byTool("gitleaks")).toEqual(["app/server.py:8 github-pat"]);
  // S608 at :22 is under a committed # nosec B608 on the statement's last line; :28 has a committed noqa.
  expect(byTool("ruff").sort()).toEqual(["app/server.py:13 S602", "app/server.py:17 S324", "app/server.py:8 S105"]);
  expect(report.ignores.committed).toBe(2);
  expect(byTool("semgrep")).toEqual(["app/server.py:13 casper.mcp-tool-shell-from-input"]);
  expect(byTool("zizmor")).toContain(".github/workflows/ci.yml:10 template-injection");
  expect(byTool("ansible-lint")).toContain("site.yml:3 risky-shell-pipe");
  expect(byTool("mcp-scanner")).toEqual(["tools.json:0 credential-harvesting"]);
  if ((await osvDbState(home)).present) expect(byTool("osv-scanner")).toContain("requirements.txt:1 GHSA-8r7q-cvjq-x353");
  expect(text).not.toContain("R7bX2kQ9vLm4Tz8Wc1Yp6Nd3Hs5Jf0Ga2Ue7");
  expect(text).not.toContain("abc123");
}, 600_000);
