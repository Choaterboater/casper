import { expect, test } from "bun:test";
import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { notesServer } from "./support/notes-server";
import { sandboxAvailable } from "./support/platform";
import { cleanUpAfterEach, fixture, events, fixProject, lastUser, REVIEW, reviewOn, asked, shellCheckTest } from "./support/scripting";
import { waitUntil } from "./support/wait";

cleanUpAfterEach();

shellCheckTest("--json streams v1 JSON Lines on stdout: session, text, tools, Casper's check and one receipt", async () => {
  const f = await fixture((request, payload) => lastUser(payload).includes(REVIEW) ? { text: "Requirements:\n- [x] sum.js is fixed — the test check" }
    : request === 0 ? { tools: [{ name: "write", args: { path: "sum.js", content: "fixed\n" } }] }
    : { text: "Fixed \u001b[31msum.js\u202e." });
  await fixProject(f);
  await reviewOn(f);
  const result = await f.run(["--json", "--verify", "--require-verification", "Fix sum.js"]);
  expect(result.exit).toBe(0);
  // The transcript and the short receipt a person reads moved to stderr; the JSON receipt keeps the full text.
  expect(result.stderr).toContain("✓ Verified · test passed · changed sum.js\n");
  expect(result.stdout).not.toMatch(/[\x1b\u202e]/);
  const receiptText = "✓ Verified — the checks pass, and the tests fail without the change\n✓ Changed 1 file: sum.js\n✓ test passed (grep -q fixed sum.js";
  const stream = events(result.stdout, await realpath(f.project));
  const receipt = stream.at(-1);
  // The check's time shows only from a second up.
  expect(receipt.text).toMatch(new RegExp(`^${receiptText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:, \\d+\\.\\ds)?\\)\\n`));
  receipt.text = "<receipt text>";
  // Three model responses (the task, its answer, the requirements review) at 120 tokens each; the
  // cost is the catalog estimate for those tokens.
  expect(receipt.usage.estimatedCost).toBeCloseTo(0.00042, 10);
  receipt.usage.estimatedCost = "<cost>";
  // Where the real sandbox runs here, the check ran in it and the receipt says so.
  if (sandboxAvailable) expect(receipt.sandbox).toEqual({ held: true, reason: null });
  delete receipt.sandbox;
  expect(stream).toEqual([
    { v: 1, type: "session_start", casper: "<version>", cwd: "<project>", session: "<id>", provider: "fixture", model: "first", effort: stream[0].effort },
    { v: 1, type: "phase", phase: "task", state: "start", atMs: "<ms>" },
    { v: 1, type: "tool_start", tool: "write", id: "call_0", target: "sum.js" },
    { v: 1, type: "tool_end", tool: "write", id: "call_0", ok: true, ms: "<ms>" },
    { v: 1, type: "assistant_delta", text: "Fixed \u001b[31msum.js\u202e." },
    { v: 1, type: "assistant_message", text: "Fixed \u001b[31msum.js\u202e." },
    { v: 1, type: "phase", phase: "task", state: "end", atMs: "<ms>" },
    { v: 1, type: "phase", phase: "checks", state: "start", atMs: "<ms>" },
    { v: 1, type: "check", name: "test", command: "grep -q fixed sum.js", status: "pass", exit: 0, ms: "<ms>", recordedBy: "casper", reused: false },
    { v: 1, type: "phase", phase: "checks", state: "end", atMs: "<ms>" },
    { v: 1, type: "phase", phase: "review", state: "start", atMs: "<ms>" },
    // The requirements review: the model's checklist, then no rerun because it changed nothing.
    { v: 1, type: "assistant_delta", text: "Requirements:\n- [x] sum.js is fixed — the test check" },
    { v: 1, type: "assistant_message", text: "Requirements:\n- [x] sum.js is fixed — the test check" },
    { v: 1, type: "phase", phase: "review", state: "end", atMs: "<ms>" },
    { v: 1, type: "phase", phase: "proof", state: "start", atMs: "<ms>" },
    { v: 1, type: "phase", phase: "proof", state: "end", atMs: "<ms>" },
    { v: 1, type: "receipt", outcome: "verified", exitCode: 0, execution: "completed", changed: ["sum.js"], changedDuringChecks: [],
      verificationMode: "auto", checks: [{ name: "test", command: "grep -q fixed sum.js", status: "pass", exit: 0, ms: "<ms>", fresh: true }],
      repairAttempts: 0, turnLimit: null, spendLimit: null, remoteChanges: [], remoteNotRun: [], secretInCommand: false, usage: { turns: 3, tokens: 360, estimatedCost: "<cost>" },
      // The check fails on sum.js as it was, so it proves the fix.
      proof: { status: "proven", check: "test", command: "grep -q fixed sum.js", testsChanged: false, without: { exitCode: 1, ended: "fail" } },
      proofSkipped: null,
      review: { done: ["sum.js is fixed — the test check"], open: [] }, acceptance: null, checklist: null, services: [], smoke: null,
      // Added in v0.2.16, within v1.
      pages: null, checksPassed: true, repairModels: null, bigModel: null, security: null, task: 1, undo: { available: true, reason: null },
      changedWhilePlanning: null, pageNotes: null,
      verdict: "✓ Verified — the checks pass, and the tests fail without the change", text: "<receipt text>" },
  ]);
}, 90_000);

test("--json exit codes match the receipt: failed 1, not verified 3, usage 64 with nothing on stdout", async () => {
  const failing = await fixture(() => ({ text: "sum.js looks broken." }));
  await fixProject(failing);
  await writeFile(path.join(failing.project, ".casper/project.yaml"), 'verify:\n  test: "grep -q fixed sum.js"\nrepair:\n  maxAttempts: 0\n');
  const noChange = await failing.run(["--json", "--require-verification", "Look at sum.js"]);
  const receipt = (stdout: string) => JSON.parse(stdout.trim().split("\n").at(-1)!);
  // No files changed: nothing to verify, so even --require-verification exits 0.
  expect({ exit: noChange.exit, outcome: receipt(noChange.stdout).outcome }).toEqual({ exit: 0, outcome: "unchanged" });

  const broken = await fixture((request) => request === 0
    ? { tools: [{ name: "write", args: { path: "sum.js", content: "still broken\n" } }] } : { text: "Done." });
  await fixProject(broken);
  await writeFile(path.join(broken.project, ".casper/project.yaml"), 'verify:\n  test: "grep -q fixed sum.js"\nrepair:\n  maxAttempts: 0\n');
  const failed = await broken.run(["--json", "--verify", "Fix sum.js"]);
  expect({ exit: failed.exit, outcome: receipt(failed.stdout).outcome, exitCode: receipt(failed.stdout).exitCode }).toEqual({ exit: 1, outcome: "failed", exitCode: 1 });

  const unchecked = await fixture((request) => request === 0
    ? { tools: [{ name: "write", args: { path: "notes.txt", content: "x\n" } }] } : { text: "Done." });
  const notVerified = await unchecked.run(["--json", "--require-verification", "Write notes"]);
  expect({ exit: notVerified.exit, outcome: receipt(notVerified.stdout).outcome }).toEqual({ exit: 3, outcome: "not_verified" });

  const usage = await unchecked.run(["--json"]);
  expect({ exit: usage.exit, stdout: usage.stdout }).toEqual({ exit: 64, stdout: "" });
  expect(usage.stderr).toContain("--json needs a prompt");
}, 240_000);

test("an ignored PI_CODING_AGENT_DIR is a [config] warning on the app's output: stdout when plain, stderr (never JSON stdout) with --json", async () => {
  const f = await fixture();
  const warning = "[config] Ignoring PI_CODING_AGENT_DIR; use CASPER_AGENT_DIR to choose Casper's state directory.";
  const inherited = { PI_CODING_AGENT_DIR: path.join(f.root, "pi-agent") };
  const plain = await f.run(["Answer without tools"], f.project, inherited);
  expect({ exit: plain.exit, stderr: plain.stderr }).toEqual({ exit: 0, stderr: "" });
  expect(plain.stdout).toContain(`${warning}\n`);
  const json = await f.run(["--json", "Answer without tools"], f.project, inherited);
  expect(json.exit).toBe(0);
  expect(json.stderr).toContain(`${warning}\n`);
  for (const line of json.stdout.trim().split("\n")) expect(() => JSON.parse(line)).not.toThrow();
}, 90_000);

test("--json ends with an error event when Casper stops before a receipt", async () => {
  const f = await fixture();
  const result = await f.run(["--json", "--model", "fixture/nope", "hi"]);
  expect(result.exit).toBe(64);
  const lines = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  expect(lines.map((line) => line.type)).toEqual(["error"]);
  expect(lines[0].message).toContain("Unknown model");
}, 60_000);

shellCheckTest("--json tells a check the model asked for (casper_check) from one Casper ran", async () => {
  const f = await fixture((request) => request === 0 ? { tools: [{ name: "write", args: { path: "sum.js", content: "fixed\n" } }] }
    : request === 1 ? { tools: [{ name: "casper_check", args: { check: "test" } }] } : { text: "Fixed." });
  await fixProject(f);
  const result = await f.run(["--json", "--verify", "Fix sum.js"]);
  expect(result.exit).toBe(0);
  const checks = events(result.stdout, "").filter((event) => event.type === "check");
  // Without a declared scope Casper cannot prove the model's pass is still fresh, so its final run repeats it.
  expect(checks.map((check) => [check.recordedBy, check.status, check.reused])).toEqual([["casper_check", "pass", false], ["casper", "pass", false]]);
}, 60_000);

test("--json --verify: the model records a smoke check, edits, and Casper replays it: pass with a failing baseline, no service left running", async () => {
  const check = { action: "check", name: "create note", service: "api", request: { method: "POST", path: "/notes", body: { title: "a" } }, expect: { status: 201, json: { title: "a" } } };
  let pidLog = "";
  const f = await fixture((request) => request === 0 ? { tools: [{ name: "service", args: check }] }
    : request === 1 ? { tools: [{ name: "write", args: { path: "src/server.ts", content: notesServer(true, pidLog) } }] }
    : { text: "Added POST /notes." });
  // In the run's own temp folder (TMPDIR is its HOME), which the sandbox lets a service write on every host; the
  // fixture's parent folder is under /tmp only on Linux (macOS's temp folder is /private/var/folders/...).
  await mkdir(path.join(f.root, "home"), { recursive: true });
  pidLog = path.join(f.root, "home", "pids.log");
  await mkdir(path.join(f.project, ".casper"));
  await mkdir(path.join(f.project, "src"));
  await writeFile(path.join(f.project, "src/server.ts"), notesServer(false, pidLog));
  await writeFile(path.join(f.project, ".casper/project.yaml"), JSON.stringify({ services: { api: {
    command: `"${process.execPath}" src/server.ts`, port: "auto", ready: { http: "/health" }, timeoutMs: 10_000, scope: { inputs: ["src"] } } } }));
  const result = await f.run(["--json", "--verify", "Add POST /notes that creates a note"]);
  const stream = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  const receipt = stream.at(-1);
  // The model saw its check fail before the edit.
  const toolResult = JSON.parse(String(f.payloads[1]!.messages.at(-1)!.content));
  expect(toolResult.data.check).toMatchObject({ baseline: "fail", actual: { status: 404 } });
  // The smoke check passed with a failing baseline, but no test was compared with and without the change: the checks
  // passed, and the outcome is not "verified" (a proven change).
  expect({ exit: result.exit, outcome: receipt.outcome, checksPassed: receipt.checksPassed, smoke: receipt.smoke }).toEqual({ exit: 0, outcome: "not_verified", checksPassed: true, smoke: { status: "pass", checks: [{
    id: "smoke-1", name: "create note", service: "api", source: "model", request: { method: "POST", path: "/notes" }, baseline: "fail", status: "pass",
    actual: { status: 201, body: '{"id":1,"title":"a"}' }, restarted: true, evidence: true }] } });
  expect(receipt.services).toEqual([{ name: "api", origin: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/), state: "ready" }]);
  expect(receipt.text).toContain("smoke 1/1 passed (model-declared, run by Casper: create note failed before the change)");
  expect(stream.filter((event) => event.type === "phase" && event.phase === "smoke").map((event) => event.state)).toEqual(["start", "end"]);
  // Casper started the unsolved server, then the fixed one after the edit; neither outlives the run.
  const pids = (await readFile(pidLog, "utf8")).trim().split("\n").map(Number);
  expect(pids).toHaveLength(2);
  if (sandboxAvailable && process.platform === "linux") {
    // In the Linux sandbox a service has its own process numbers, so look for any process still in the project.
    const project = await realpath(f.project);
    const left: string[] = [];
    for (const entry of await readdir("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const cwd = await import("node:fs/promises").then((fs) => fs.readlink(`/proc/${entry}/cwd`)).catch(() => "");
      if (cwd === project || cwd.startsWith(`${project}/`)) left.push(entry);
    }
    expect(left).toEqual([]);
  } else {
    // A stopped process can still be listed for a moment (on Windows a kill only starts its exit), so wait for it to
    // be gone, with a deadline. One that was never stopped is still there at the deadline.
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (const pid of pids) expect(await waitUntil(() => !alive(pid), 5_000)).toBe(true);
  }
}, 60_000);
