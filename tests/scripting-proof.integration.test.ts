import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isolatedEnvironment } from "../src/platform/environment";
import { cleanUpAfterEach, fixture, fixProject, lastUser, afterTool, REVIEW, reviewOn, PROOF_REPAIR, weaklyTestedProject, asked, TICKED, shellCheckTest, isAcceptance } from "./support/scripting";
import { childTestLimit } from "./support/limits";

cleanUpAfterEach();

/** Real CLI, with only sandbox detection forced to Windows (no sandbox, noninteractive shell approvals). */
async function runWithWindowsSandbox(f: Awaited<ReturnType<typeof fixture>>) {
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/scripting-windows.ts"), "--json", "--verify", "--require-verification", "Fix sum.js"], {
    cwd: f.project, env: { ...isolatedEnvironment(f.home), CASPER_OFFLINE: "1" }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 60_000);
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exit };
  } finally { clearTimeout(timer); }
}

shellCheckTest("an unproven fix gets one round to add a test that fails without it; then the receipt says proven", async () => {
  const f = await fixture((_request, payload) => {
    const prompt = lastUser(payload);
    if (prompt.includes(PROOF_REPAIR)) return afterTool(payload) ? { text: "Added a test that fails on the broken code." }
      : { tools: [{ name: "write", args: { path: "tests/sum.test.sh", content: "grep -q fixed sum.js\n" } }] };
    if (prompt.includes(REVIEW)) return TICKED;
    return afterTool(payload) ? { text: "Fixed sum.js." } : { tools: [{ name: "write", args: { path: "sum.js", content: "fixed\n" } }] };
  });
  await weaklyTestedProject(f);
  // Keep the configured runner unchanged; the repair adds a discovered regression test, not a check rewrite.
  await writeFile(path.join(f.project, "tests/check.sh"), 'test -f sum.js || exit\nfor file in tests/*.test.sh; do\n  [ ! -f "$file" ] || sh "$file" || exit\ndone\n');
  await reviewOn(f);
  const result = await f.run(["--json", "--verify", "--require-verification", "Fix sum.js"]);
  // The first turn is the request itself; the review comes before the proof, and the proof round asks for the test.
  expect(asked(f.payloads[0], "fail without your change")).toBe(false);
  expect(lastUser(f.payloads[0]!)).toContain("Fix sum.js");
  expect(f.payloads.map((payload) => lastUser(payload).includes(REVIEW) ? "review" : lastUser(payload).includes(PROOF_REPAIR) ? "proof" : "task"))
    .toEqual(["task", "task", "review", "proof", "proof"]);
  const receipt = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
  expect({ exit: result.exit, outcome: receipt.outcome, repairs: receipt.repairAttempts, proof: receipt.proof, review: receipt.review }).toEqual({
    exit: 0, outcome: "verified", repairs: 1, proof: { status: "proven", check: "test", command: "sh tests/check.sh", testsChanged: true, without: { exitCode: 1, ended: "fail" } },
    review: { done: ["sum.js is fixed — tests/check.sh"], open: [] },
  });
  expect(receipt.text).toContain("✓ Proven: test fails without this change (exit 1) and passes with it");
  expect(result.stderr).toContain("✓ Verified · test passed · changed sum.js · after 1 repair\n");
}, childTestLimit());

shellCheckTest("a fix no test proves is not verified: the receipt says why, and --require-verification exits 3", async () => {
  const f = await fixture((_request, payload) => lastUser(payload).includes(REVIEW) ? TICKED
    : afterTool(payload) || lastUser(payload).includes(PROOF_REPAIR) ? { text: "Fixed sum.js." }
    : { tools: [{ name: "write", args: { path: "sum.js", content: "fixed\n" } }] });
  await weaklyTestedProject(f);
  const result = await f.run(["--json", "--verify", "--require-verification", "Fix sum.js"]);
  const receipt = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
  expect({ exit: result.exit, outcome: receipt.outcome, proof: receipt.proof?.status, testsChanged: receipt.proof?.testsChanged })
    .toEqual({ exit: 3, outcome: "not_verified", proof: "unproven", testsChanged: false });
  expect(receipt.text).toContain("⚠ Not proven: test passes without this change too, and no test was added or changed");
  // Exactly one proof round was asked for; the model's answer did not add a test.
  expect(f.payloads.filter((payload) => lastUser(payload).includes(PROOF_REPAIR)).length).toBe(1);
}, 180_000);

shellCheckTest("a feature worded like a test task is still reviewed and proven; a docs-only edit is not", async () => {
  // "new test files" makes the keyword classifier say intent "test"; the work (a code change) decides.
  const f = await fixture((_request, payload) => lastUser(payload).includes(REVIEW) ? TICKED
    : afterTool(payload) ? { text: "Done." } : { tools: [{ name: "write", args: { path: "sum.js", content: "fixed\n" } }] });
  await fixProject(f);
  await reviewOn(f);
  const result = await f.run(["--json", "--verify", "sum.js should print fixed; you may add new test files"]);
  const receipt = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
  expect({ proof: receipt.proof?.status, review: receipt.review }).toEqual({ proof: "proven", review: { done: ["sum.js is fixed — tests/check.sh"], open: [] } });

  const docs = await fixture((_request, payload) => afterTool(payload) ? { text: "Documented." } : { tools: [{ name: "write", args: { path: "NOTES.md", content: "notes\n" } }] });
  await fixProject(docs);
  await writeFile(path.join(docs.project, ".casper/project.yaml"), 'verify:\n  test: "test -f sum.js"\n');
  const documented = await docs.run(["--json", "--verify", "Add notes about sum.js"]);
  const docsReceipt = JSON.parse(documented.stdout.trim().split("\n").at(-1)!);
  expect({ outcome: docsReceipt.outcome, proof: docsReceipt.proof, review: docsReceipt.review }).toEqual({ outcome: "not_verified", proof: null, review: null });
  // Only a doc changed, so no unscoped check ran (the receipt says so); the docs edit was not proven, so the outcome is not verified.
  expect({ checksPassed: docsReceipt.checksPassed, exit: documented.exit }).toEqual({ checksPassed: false, exit: 0 });
  expect(docs.payloads.some((payload) => lastUser(payload).includes(REVIEW))).toBe(false);
}, childTestLimit(2));

shellCheckTest("the review round runs even after a fully ticked first checklist, and the receipt keeps the review's", async () => {
  const f = await fixture((_request, payload) => lastUser(payload).includes(REVIEW) ? TICKED
    : afterTool(payload) ? { text: "Fixed sum.js.\n\nRequirements:\n- [x] sum.js prints fixed — tests/sum.sh" }
    : { tools: [{ name: "write", args: { path: "sum.js", content: "fixed\n" } }, { name: "write", args: { path: "tests/sum.sh", content: "grep -q fixed sum.js\n" } }] });
  await fixProject(f);
  await reviewOn(f);
  const result = await f.run(["--json", "--verify", "Fix sum.js"]);
  // B: the first turn is the request itself; the review asks for the checklist, with the ticking rule.
  expect(asked(f.payloads[0], "Count a requirement as done only when a test you can name asserts it")).toBe(false);
  // A fully ticked first checklist was wrong too often to skip the review; the review starts from it.
  const reviews = f.payloads.filter((payload) => lastUser(payload).includes(REVIEW));
  expect(reviews.length).toBeGreaterThan(0);
  expect(lastUser(reviews[0]!)).toContain("start from it: add what it missed and split what it merged");
  expect(lastUser(reviews[0]!)).toContain("Covered: <n> of <m> requirements.");
  const receipt = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
  expect({ outcome: receipt.outcome, review: receipt.review, proof: receipt.proof?.status })
    .toEqual({ outcome: "verified", review: { done: ["sum.js is fixed — tests/check.sh"], open: [] }, proof: "proven" });
}, childTestLimit());

shellCheckTest("the review round is off by default (and with verification.review: false); the change is still proven", async () => {
  const f = await fixture((_request, payload) => lastUser(payload).includes(REVIEW) ? TICKED
    : afterTool(payload) ? { text: "Fixed." } : { tools: [{ name: "write", args: { path: "sum.js", content: "fixed\n" } }] });
  // Pinned benchmarks: the review added no first-time-right and cost 40% of the wall time; the checks and the proof decide.
  await fixProject(f);
  const result = await f.run(["--json", "--verify", "Fix sum.js"]);
  expect(f.payloads.some((payload) => lastUser(payload).includes(REVIEW))).toBe(false);
  // No review follows, so the first turn itself asks for the checklist and a test that fails without the change.
  expect(asked(f.payloads[0], "Count a requirement as done only when a test you can name asserts it")).toBe(true);
  expect(asked(f.payloads[0], "fail without your change")).toBe(true);
  const receipt = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
  expect({ outcome: receipt.outcome, proof: receipt.proof?.status, review: receipt.review }).toEqual({ outcome: "verified", proof: "proven", review: null });

  // The benchmark's casper-no-review sets it explicitly in the user configuration (~/.casper/config.yaml).
  const user = await fixture((_request, payload) => lastUser(payload).includes(REVIEW) ? TICKED
    : afterTool(payload) ? { text: "Fixed." } : { tools: [{ name: "write", args: { path: "sum.js", content: "fixed\n" } }] });
  await fixProject(user);
  await mkdir(path.join(user.home, ".casper"), { recursive: true });
  await writeFile(path.join(user.home, ".casper/config.yaml"), "verification:\n  review: false\n");
  expect((await user.run(["--json", "--verify", "Fix sum.js"])).exit).toBe(0);
  expect(user.payloads.some((payload) => lastUser(payload).includes(REVIEW))).toBe(false);
}, childTestLimit(2));

shellCheckTest("a change that rewrites what the test command runs is not verified, and gets no acceptance pass", async () => {
  // The command stays `sh run-tests.sh`; the change rewrites run-tests.sh itself so it passes without testing anything.
  const f = await fixture((_request, payload) => isAcceptance(payload) ? { text: "```js\ntest(\"sum is fixed\", () => { throw new Error(\"no\"); });\n```" }
    : lastUser(payload).includes(REVIEW) ? TICKED
    : afterTool(payload) || lastUser(payload).includes(PROOF_REPAIR) ? { text: "Fixed sum.js." }
    : { tools: [{ name: "write", args: { path: "sum.js", content: "still broken\n" } }, { name: "bash", args: { command: "bun run rewrite" } }] });
  await mkdir(path.join(f.project, ".casper"));
  await writeFile(path.join(f.project, ".casper/project.yaml"), 'verify:\n  test: "sh run-tests.sh"\nverification:\n  acceptance: true\n');
  await writeFile(path.join(f.project, "run-tests.sh"), "grep -q fixed sum.js\n");
  // Native rewrites now correctly need approval. An opaque script can still change the definition;
  // this end-of-task evidence check must catch that independently of the write-time text guard.
  await writeFile(path.join(f.project, "rewrite.sh"), "printf 'true\\n' > run-tests.sh\n");
  // A package script is routine on Windows too; a bare sh rewrite.sh is correctly refused without a person.
  await writeFile(path.join(f.project, "package.json"), JSON.stringify({ scripts: { rewrite: "sh rewrite.sh" } }));
  await writeFile(path.join(f.project, "sum.js"), "broken\n");
  const result = await runWithWindowsSandbox(f);
  expect(await readFile(path.join(f.project, "run-tests.sh"), "utf8")).toBe("true\n");
  expect(JSON.stringify(f.payloads)).not.toContain("Not run: shell commands need your OK");
  const receipt = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
  expect({ exit: result.exit, outcome: receipt.outcome, proof: receipt.proof?.status }).toEqual({ exit: 3, outcome: "not_verified", proof: "unavailable" });
  expect(receipt.proof.reason).toContain("the test command's definition changed in this task (run-tests.sh)");
  // The acceptance check would run through the same rewritten script: it is not run, and says why.
  expect(receipt.acceptance?.status).toBe("error");
  expect(f.payloads.filter(isAcceptance)).toHaveLength(0);
}, 60_000);

test("a rewritten test command with Windows-style paths and CRLF is not verified on any OS, with no acceptance pass", async () => {
  const f = await fixture((_request, payload) => isAcceptance(payload) ? { text: "Unexpected acceptance call." }
    : afterTool(payload) || lastUser(payload).includes(PROOF_REPAIR) ? { text: "Fixed sum.js." }
    : { tools: [{ name: "write", args: { path: "sum.js", content: "still broken\r\n" } }, { name: "bash", args: { command: "bun run rewrite" } }] });
  await mkdir(path.join(f.project, ".casper"));
  await mkdir(path.join(f.project, "scripts"));
  const command = 'bun run ".\\scripts\\run-check.ts"';
  await writeFile(path.join(f.project, ".casper/project.yaml"), `verify:\r\n  test: ${JSON.stringify(command)}\r\nverification:\r\n  acceptance: true\r\n`);
  await writeFile(path.join(f.project, "package.json"), JSON.stringify({ scripts: { rewrite: "bun run scripts/rewrite.ts" } }));
  await writeFile(path.join(f.project, "scripts/run-check.ts"), 'if ((await Bun.file("sum.js").text()).trim() !== "fixed") process.exit(1);\r\n');
  const rewritten = "process.exit(0);\r\n";
  await writeFile(path.join(f.project, "scripts/rewrite.ts"), `await Bun.write(new URL("./run-check.ts", import.meta.url), ${JSON.stringify(rewritten)});\r\n`);
  await writeFile(path.join(f.project, "sum.js"), "broken\r\n");
  const result = await runWithWindowsSandbox(f);
  expect(await readFile(path.join(f.project, "scripts/run-check.ts"), "utf8")).toBe(rewritten);
  const receipt = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
  expect({ exit: result.exit, outcome: receipt.outcome, proof: receipt.proof?.status }).toEqual({ exit: 3, outcome: "not_verified", proof: "unavailable" });
  expect(receipt.proof.reason).toContain("the test command's definition changed in this task (scripts/run-check.ts)");
  expect(receipt.checks[0]).toMatchObject({ command, status: "pass" });
  expect(receipt.acceptance?.status).toBe("error");
  expect(f.payloads.filter(isAcceptance)).toHaveLength(0);
}, 60_000);
