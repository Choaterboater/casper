import { afterEach, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfiguration } from "../src/config/load";
import { ServiceManager } from "../src/services/manager";
import { SmokeChecks } from "../src/services/smoke";
import { prepareWorkdir, referenceChanges } from "../evals/runner";
import { findEvalTask } from "../evals/tasks";
import { flakyOn } from "./support/platform";
import { removeTempDir } from "./support/temp-dir";

const repoRoot = path.resolve(import.meta.dir, "..");
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** True when a SIGTERM sent from here reaches a handler in a Bun child, the same probe the lifecycle
 * acceptance runs. On Windows it does not (Bun's `kill("SIGTERM")` ends the process at once), so the
 * acceptance skips its graceful-shutdown case there and these tests expect that skip. */
async function sigtermReachesHandler(): Promise<boolean> {
  const child = Bun.spawn([process.execPath, "-e",
    "process.once('SIGTERM', () => { console.log('caught'); process.exit(0); }); console.log('ready'); setInterval(() => {}, 1000);"],
  { stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let signalled = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    output += decoder.decode(value, { stream: true });
    if (!signalled && output.includes("ready")) { signalled = true; child.kill("SIGTERM"); }
  }
  clearTimeout(timer);
  await child.exited;
  return output.includes("caught");
}
const catchableSigterm = await sigtermReachesHandler();

/** Both harnesses see the fixture's server; Casper also reads its `services.api` and `GET /notes` smoke check. */
test.each(["solved fixture", "core-rest-validation start"])("the notes fixture server becomes ready and answers GET /notes (%s)", async (which) => {
  const task = findEvalTask("core-rest-validation")!;
  const workdir = await prepareWorkdir(which === "solved fixture" ? { ...task, setup: undefined } : task, repoRoot);
  cleanup.push(() => removeTempDir(workdir));
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-notes-server-home-"));
  cleanup.push(() => removeTempDir(home));
  const config = await loadConfiguration({ projectRoot: workdir, homeDir: home });
  expect(config.warnings ?? []).toEqual([]);
  expect(config.services.api).toMatchObject({ port: "auto", ready: { http: "/notes" } });
  // No configured check for the endpoint the task adds: that would be a spec only Casper sees.
  expect(config.smoke.map((check) => `${check.request.method} ${check.request.path}`)).toEqual(["GET /notes"]);
  expect(JSON.parse(await readFile(path.join(workdir, "package.json"), "utf8")).scripts.dev).toBeString();

  const manager = new ServiceManager({ projectRoot: workdir, services: config.services });
  cleanup.push(() => manager.close().catch(() => {}));
  const started = await manager.start("api", new AbortController().signal);
  expect(started.state).toBe("ready");
  const origin = manager.origin("api")!;
  expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  const response = await fetch(`${origin}/notes`);
  expect({ status: response.status, body: await response.json() }).toEqual({ status: 200, body: { notes: [] } });
  const report = await new SmokeChecks(config.smoke, () => manager).run(new AbortController().signal);
  expect({ status: report.status, checks: report.checks.map(({ source, status, evidence }) => ({ source, status, evidence })) })
    .toEqual({ status: "pass", checks: [{ source: "config", status: "pass", evidence: true }] });
  await manager.close();
  expect(alive(started.pid!)).toBe(false);
}, 30_000);

test("the fixture server is fixture code the validation task's setup leaves alone", async () => {
  const task = findEvalTask("core-rest-validation")!;
  const changes = await referenceChanges(task, repoRoot);
  const touched = [...changes.added, ...changes.modified, ...changes.removed];
  expect(touched.filter((entry) => entry === "src/server.ts" || entry === "package.json" || entry.startsWith(".casper/"))).toEqual([]);
});

/** True when `pid` is still a server started from `evaluator`. A live PID alone is not proof: Windows hands a
 * freed PID to a new process within moments, so the command line must name this evaluator's folder. */
function runsServerFrom(pid: number, evaluator: string): boolean {
  if (!alive(pid)) return false;
  const query = process.platform === "win32"
    ? ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`]
    : ["ps", "-o", "args=", "-p", String(pid)];
  let listed: ReturnType<typeof Bun.spawnSync>;
  try { listed = Bun.spawnSync(query, { stdout: "pipe", stderr: "ignore" }); }
  catch { return true; } // No way to read command lines here: a live PID counts.
  return listed.stdout!.toString().includes(path.basename(evaluator));
}

/** Run the lifecycle task's hidden acceptance over `src` from `source`, as the frozen evaluator does,
 * and report each test's result and the server PIDs it said it spawned. */
async function lifecycleAcceptance(source: string) {
  const task = findEvalTask("core-service-lifecycle")!;
  const evaluator = await prepareWorkdir({ ...task, setup: undefined }, repoRoot);
  cleanup.push(() => removeTempDir(evaluator));
  await removeTempDir(path.join(evaluator, "src"));
  await cp(path.join(source, "src"), path.join(evaluator, "src"), { recursive: true });
  // Bun prints no `(pass)` lines when it detects an AI agent (AGENT=1, CLAUDECODE=1, ...), and the results are read from them.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(AGENT|AI_AGENT|CLAUDECODE|OMPCODE|CURSOR_AGENT|GEMINI_CLI|CODEX_\w+)$/.test(name)));
  const run = Bun.spawn([process.execPath, "test", "./acceptance/server-lifecycle.test.ts"], { cwd: evaluator, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
  const output = `${stdout}${stderr}`;
  const pids = [...output.matchAll(/\[server-lifecycle\] spawned pid (\d+)/g)].map((match) => Number(match[1]));
  // Kill by PID anything the acceptance left behind, after recording that it survived.
  const survivors = pids.filter((pid) => runsServerFrom(pid, evaluator));
  for (const pid of survivors) process.kill(pid, "SIGKILL");
  const results = [...output.matchAll(/^\((pass|fail|skip)\) (.+?)(?: \[[\d.]+m?s\])?$/gm)].map((match) => `${match[1]} ${match[2]!.split(" ").slice(0, 3).join(" ")}`);
  return { exitCode, results, pids, survivors, tail: exitCode ? output.slice(-1500) : "" };
}

/** The solved fixture with `edits` applied to its `src/` files, each replacement required to match. */
async function variant(edits: Record<string, [string, string][]>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-lifecycle-variant-"));
  cleanup.push(() => removeTempDir(root));
  await cp(path.join(repoRoot, "evals/fixtures/notes-api/src"), path.join(root, "src"), { recursive: true });
  for (const [file, replacements] of Object.entries(edits)) {
    // A checkout with CRLF line endings (core.autocrlf) must still match the LF replacements.
    let text = (await readFile(path.join(root, "src", file), "utf8")).replaceAll("\r\n", "\n");
    for (const [from, to] of replacements) { expect(text).toContain(from); text = text.replace(from, to); }
    await writeFile(path.join(root, "src", file), text);
  }
  return root;
}

const ALL = ["GET /health answers", "the server listens", "the server listens", "on SIGTERM an"];
const SIGTERM_CASE = 3;
const results = (failing: number[]) => ALL.map((name, index) =>
  `${index === SIGTERM_CASE && !catchableSigterm ? "skip" : failing.includes(index) ? "fail" : "pass"} ${name}`);

test("the lifecycle task's hidden acceptance passes on the solved fixture and fails on its start, leaving no server behind", async () => {
  const solved = await lifecycleAcceptance(path.join(repoRoot, "evals/fixtures/notes-api"));
  expect({ exit: solved.exitCode, results: solved.results, survivors: solved.survivors, tail: solved.tail })
    .toEqual({ exit: 0, results: results([]), survivors: [], tail: "" });
  const start = await prepareWorkdir(findEvalTask("core-service-lifecycle")!, repoRoot);
  cleanup.push(() => removeTempDir(start));
  const unsolved = await lifecycleAcceptance(start);
  expect({ exit: unsolved.exitCode, results: unsolved.results }).toEqual({ exit: 1, results: results([0, 1, 2, 3]) });
  // Failing tests still stop every server they started (the setup's server never exits on its own).
  expect(unsolved.pids.length).toBe(catchableSigterm ? 4 : 3);
  expect(unsolved.survivors).toEqual([]);
}, { timeout: 90_000, ...flakyOn("win32") });

/** Each behavior the setup removes is caught on its own: the solved server minus just that behavior fails just its test. */
test.each<[string, Record<string, [string, string][]>, number[]]>([
  ["no /health", { "app.ts": [["if (pathname === \"/health\")", "if (pathname === \"/nothing\")"]] }, [0]],
  ["HOST ignored", { "server.ts": [["process.env.HOST || \"127.0.0.1\"", "\"127.0.0.1\""]] }, [2]],
])("the lifecycle acceptance catches a server with %s", async (_name, edits, failing) => {
  const run = await lifecycleAcceptance(await variant(edits));
  expect({ results: run.results, survivors: run.survivors }).toEqual({ results: results(failing), survivors: [] });
}, 60_000);

/** Shutdown behaviors are only observable where a SIGTERM can be caught (not on Windows). */
test.skipIf(!catchableSigterm).each<[string, Record<string, [string, string][]>, number[]]>([
  ["no graceful SIGTERM", { "server.ts": [["process.once(\"SIGTERM\"", "process.once(\"SIGUSR2\""]] }, [3]],
  ["exits on SIGTERM without draining", { "server.ts": [["void server.stop().then(() => process.exit(0));", "process.exit(0);"]] }, [3]],
  ["drains but never exits", { "server.ts": [["setTimeout(() => process.exit(0), 1_500).unref();\n  void server.stop().then(() => process.exit(0));", "void server.stop();\n  setInterval(() => {}, 1_000);"]] }, [3]],
])("the lifecycle acceptance catches a server with %s", async (_name, edits, failing) => {
  const run = await lifecycleAcceptance(await variant(edits));
  expect({ results: run.results, survivors: run.survivors }).toEqual({ results: results(failing), survivors: [] });
}, 60_000);
