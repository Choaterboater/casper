/**
 * Host platform self-check: exercises Casper's real OS integration on the machine
 * it runs on. No model, network, dependency install or personal credentials.
 *
 *   bun tools/platform-report.ts
 *
 * Exit code 0 = every required check passed; 1 = at least one failed. Run this on
 * Windows and Linux before trusting the platform support table in README.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { browserCandidates, discoverBrowser } from "../src/browser/discovery";
import { isolatedEnvironment } from "../src/platform/environment";
import { openNoFollow } from "../src/platform/files";
import { hostProcessPlatform, osSupportsProcessGroups, OwnedProcesses, terminateTree } from "../src/platform/processes";

interface Check { name: string; status: "pass" | "fail" | "skip"; detail: string }
const checks: Check[] = [];
const record = (name: string, status: Check["status"], detail: string) => { checks.push({ name, status, detail }); };
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function until(condition: () => boolean, deadlineMs: number): Promise<boolean> {
  const limit = performance.now() + deadlineMs;
  while (performance.now() < limit) {
    if (condition()) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return false;
}

async function checkProcessListing(): Promise<void> {
  try {
    const table = await hostProcessPlatform().list();
    const self = table.get(process.pid);
    record("process listing", "pass",
      `${table.size} processes; self pid=${process.pid} parent=${self?.parent ?? "absent"} group=${self?.group ?? "absent"} stamp=${self?.stamp ? "present" : "absent"}`);
  } catch (error) {
    record("process listing", "fail", error instanceof Error ? error.message : String(error));
  }
}

async function checkSpawnedTree(root: string): Promise<void> {
  const fixture = path.join(root, "descendant.mjs");
  const report = path.join(root, "descendants.json");
  await writeFile(fixture, [
    'import { spawn } from "node:child_process";',
    'import { writeFileSync } from "node:fs";',
    'const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
    "writeFileSync(process.argv[2], JSON.stringify({ root: process.pid, grandchild: grandchild.pid }));",
    "setInterval(() => {}, 1000);",
  ].join("\n"));
  const child = spawn(process.execPath, [fixture, report], { detached: osSupportsProcessGroups, stdio: "ignore" });
  const control = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  let owner: OwnedProcesses | undefined;
  let grandchild = 0;
  try {
    const written = await until(() => existsSync(report), 10_000);
    if (!written || !child.pid) { record("descendant observation", "fail", "fixture did not report its descendants"); return; }
    const parsed = JSON.parse(await readFile(report, "utf8")) as { root: number; grandchild: number };
    grandchild = parsed.grandchild;
    owner = new OwnedProcesses(child.pid, () => child.exitCode === null && child.signalCode === null, hostProcessPlatform());
    await owner.capture();
    await owner.captureCurrent();
    record("descendant observation", "pass", `root pid=${child.pid}, grandchild pid=${grandchild}`);
    const outcome = await owner.stop();
    const gone = await until(() => !alive(child.pid!) && !alive(grandchild), 5000);
    record("owned tree cleanup", outcome === "stopped" && gone ? "pass" : "fail",
      `outcome=${outcome}; root alive=${alive(child.pid)}; grandchild alive=${alive(grandchild)}`);
    record("unrelated process control", control.pid && alive(control.pid) ? "pass" : "fail",
      `unrelated pid=${control.pid ?? "absent"} alive=${control.pid ? alive(control.pid) : false}`);
  } finally {
    if (grandchild && alive(grandchild)) { terminateTree(owner, grandchild, "SIGKILL"); try { process.kill(grandchild, "SIGKILL"); } catch { /* gone */ } }
    if (child.pid && alive(child.pid)) { terminateTree(owner, child.pid, "SIGKILL"); try { process.kill(child.pid, "SIGKILL"); } catch { /* gone */ } }
    if (control.pid && alive(control.pid)) { try { process.kill(control.pid, "SIGKILL"); } catch { /* gone */ } }
  }
}

function checkEnvironment(): void {
  const env = isolatedEnvironment("/casper-probe-home", { PROBE_MARKER: "1" });
  process.env.CASPER_PROBE_CREDENTIAL = "must-not-leak";
  const allowlist = ["PATH", "HOME", "TMPDIR", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "PROBE_MARKER",
    "SystemRoot", "windir", "SystemDrive", "ComSpec", "PATHEXT", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
    "OS", "ProgramData", "ProgramFiles", "ProgramFiles(x86)"];
  const unexpected = Object.keys(env).filter(name => !allowlist.includes(name));
  const leaks = Object.values(env).includes("must-not-leak");
  delete process.env.CASPER_PROBE_CREDENTIAL;
  record("environment allowlist", !unexpected.length && !leaks ? "pass" : "fail",
    `${Object.keys(env).length} variables; unexpected=[${unexpected.join(", ")}]; credential forwarded=${leaks}`);
}

async function checkStateOpen(root: string): Promise<void> {
  const real = path.join(root, "state.json");
  await writeFile(real, "{}");
  try {
    const handle = await openNoFollow(real);
    await handle.close();
    record("state-file read", "pass", "regular file opened with the platform flag set");
  } catch (error) {
    record("state-file read", "fail", error instanceof Error ? error.message : String(error));
  }
  const linked = path.join(root, "linked.json");
  try {
    await symlink(real, linked);
  } catch {
    record("final-symlink rejection", "skip", "this host does not let the probe create a symlink (Windows needs developer mode or elevation)");
    return;
  }
  try {
    await openNoFollow(linked);
    record("final-symlink rejection", "fail", "a final symlink was opened as a state file");
  } catch (error) {
    record("final-symlink rejection", "pass", error instanceof Error ? error.message : String(error));
  }
}

async function checkBrowser(): Promise<void> {
  const candidates = browserCandidates();
  const found = await discoverBrowser(process.env.CASPER_BROWSER_EXECUTABLE);
  record("installed browser discovery", found ? "pass" : "skip",
    found ? `${found} (checked ${candidates.length} locations)` : `no installed Chrome/Edge found; checked ${candidates.join(", ") || "no locations"}`);
}

const root = await mkdtemp(path.join(os.tmpdir(), "casper-platform-report-"));
try {
  console.log(`Casper platform report — platform=${process.platform} arch=${process.arch}`);
  console.log(`Bun ${process.versions.bun ?? "unknown"} · Node compatibility ${process.version} · process groups ${osSupportsProcessGroups ? "available" : "absent"}`);
  await checkProcessListing();
  await checkSpawnedTree(root);
  checkEnvironment();
  await checkStateOpen(root);
  await checkBrowser();
  const adapter = process.env.CASPER_TEST_DEBUGPY;
  record("debugger adapter hint", adapter ? "pass" : "skip", adapter ? `CASPER_TEST_DEBUGPY=${adapter}` : "set CASPER_TEST_DEBUGPY and CASPER_TEST_PYTHON to run the real-adapter tests");
  console.log("");
  for (const check of checks) console.log(`${check.status === "pass" ? "PASS" : check.status === "fail" ? "FAIL" : "SKIP"}  ${check.name.padEnd(26)} ${check.detail}`);
  const failed = checks.filter(check => check.status === "fail");
  const skipped = checks.filter(check => check.status === "skip");
  console.log(`\n${checks.length - failed.length - skipped.length} passed, ${failed.length} failed, ${skipped.length} skipped`);
  if (failed.length) console.log(`\nReport failed checks with the platform line above; they are the ones to fix before claiming support for ${process.platform}.`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  await rm(root, { recursive: true, force: true });
}