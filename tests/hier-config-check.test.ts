import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  pythonArgv, runNetworkCheck,
} from "../src/network/checks";
import { liveCheckLine } from "../src/task/result";
import { countedResults, formatVerificationResult, repairClass, verificationStatus } from "../src/verify/evidence";
import { checkResultForModel } from "../src/verify/model-output";
import { fromNetworkResult } from "../src/verify/registry";
import type { NetworkCheckResult, NetworkCheckSpec } from "../src/network/spec";
import { fakeTool, networkFixture, RECORD_CALL, RECORD_FILE, writeProjectFile, type NetworkFixture } from "./support/network-fakes";

let fixture: NetworkFixture | undefined;
afterEach(async () => { await fixture?.cleanup(); fixture = undefined; });

const spec: NetworkCheckSpec = { kind: "report", preset: "hier-config", platform: "aoscx", running: "running.cfg", intended: "intended.cfg" };
const REPORT = JSON.stringify({
  change_lines: 12, undo_lines: 12,
  remediation: "vlan 30\nradius-server host 10.1.1.10 key plaintext RadKeyCX", rollback: "no vlan 30",
});
const PRINT_REPORT = `out(lines([${JSON.stringify(REPORT)}]));`;
// The project's Python when there is no venv: python on Windows, python3 elsewhere (pythonArgv).
const PYTHON = process.platform === "win32" ? "python" : "python3";

async function setup(body: string) {
  fixture = await networkFixture();
  await writeProjectFile(fixture, "running.cfg", "hostname sw1\n");
  await writeProjectFile(fixture, "intended.cfg", "hostname sw1\nvlan 30\n");
  await fakeTool(fixture, PYTHON, `${RECORD_CALL("python3")}\n${RECORD_FILE("args[0]", "script.py")}\n${body}`);
  return fixture;
}
const context = (f: NetworkFixture) => ({ root: f.root, path: f.path, tmpRoot: f.tmp, realHome: f.home });

test("the hier_config diff is a report: its line counts, never a pass that counts toward Verified", async () => {
  const f = await setup(PRINT_REPORT);
  const result = await runNetworkCheck("aoscx-diff", spec, context(f));
  expect(result.kind).toBe("report");
  expect(result.report).toMatchObject({ changeLines: 12, undoLines: 12 });
  const shown = fromNetworkResult(result);
  expect(liveCheckLine(shown)).toBe("• aoscx-diff · 12 lines to change · 12 to undo (a diff, not a pass/fail check)");
  expect(formatVerificationResult(shown)).toBe("• aoscx-diff  12 lines to change · 12 to undo (a diff, not a pass/fail check)");
  expect(countedResults([shown])).toEqual([]);
  expect(repairClass(shown)).toBe("never");
  // A report alone is not a pass, and it does not change the status of real checks.
  expect(verificationStatus([shown])).toBe("incomplete");
  const failing = fromNetworkResult({ ...result, name: "aruba-syntax", kind: "offline", status: "fail", report: undefined } as NetworkCheckResult);
  expect(verificationStatus([shown, failing])).toBe("fail");
  expect(verificationStatus([shown, { ...failing, status: "pass" }])).toBe("pass");
});

test("the report text is scrubbed of secrets before anyone sees it", async () => {
  const f = await setup(PRINT_REPORT);
  const result = await runNetworkCheck("aoscx-diff", spec, context(f));
  expect(result.report!.remediation).not.toContain("RadKeyCX");
  // What casper_check hands the model, and the receipt's one line.
  expect(JSON.stringify(checkResultForModel(fromNetworkResult(result)))).not.toContain("RadKeyCX");
  expect(liveCheckLine(fromNetworkResult(result))).not.toContain("RadKeyCX");
});

test("the embedded script gets the platform and the two files, run by the project's Python", async () => {
  const f = await setup(PRINT_REPORT);
  await runNetworkCheck("aoscx-diff", spec, context(f));
  const argv = (await readFile(path.join(f.records, "python3.argv"), "utf8")).trim().split("\n");
  expect(argv[0]).toEndWith("hier_config_diff.py");
  expect(argv[1]).toBe("aoscx");
  expect(argv[2]).toEndWith("running.cfg");
  expect(argv[3]).toEndWith("intended.cfg");
  expect(await readFile(path.join(f.records, "script.py"), "utf8")).toContain("WorkflowRemediation");
  expect(await readFile(path.join(f.records, "python3.env"), "utf8")).toContain("UV_OFFLINE=1");
});

test("exit 3 means hier_config is not installed: not run, with the install line for the project's runner", async () => {
  const f = await setup("process.exit(3);");
  const result = await runNetworkCheck("aoscx-diff", spec, context(f));
  expect(result).toMatchObject({ status: "skip", notRun: "tool", reason: "hier_config is not installed (pip install hier-config)" });
  await writeProjectFile(f, "uv.lock", "");
  expect(await pythonArgv(f.root)).toEqual({ argv: ["uv", "run", "--no-sync", "python"], install: "uv add --dev hier-config" });
});

const hasHierConfig = spawnSync("python3", ["-c", "import hier_config"], { stdio: "ignore" }).status === 0;

test.skipIf(!hasHierConfig)("the embedded script makes a real diff (runs only when python3 can import hier_config)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "casper-hier-"));
  try {
    const script = path.join(import.meta.dir, "..", "src", "network", "assets", "hier_config_diff.py");
    await writeFile(path.join(dir, "running.cfg"), "hostname sw1\nvlan 10\n    name users\n");
    await writeFile(path.join(dir, "intended.cfg"), "hostname sw1\nvlan 10\n    name users\nvlan 20\n    name voice\n");
    const run = spawnSync("python3", [script, "aoscx", path.join(dir, "running.cfg"), path.join(dir, "intended.cfg")], { encoding: "utf8" });
    expect(run.status).toBe(0);
    const value = JSON.parse(run.stdout);
    expect(value.change_lines).toBeGreaterThan(0);
    expect(value.remediation).toContain("vlan 20");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
