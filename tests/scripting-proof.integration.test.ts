import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { cleanUpAfterEach, fixture, fixProject, lastUser, afterTool, REVIEW, reviewOn, PROOF_REPAIR, weaklyTestedProject, asked, TICKED } from "./support/scripting";

cleanUpAfterEach();

test("an unproven fix gets one round to add a test that fails without it; then the receipt says proven", async () => {
  const f = await fixture((_request, payload) => {
    const prompt = lastUser(payload);
    if (prompt.includes(PROOF_REPAIR)) return afterTool(payload) ? { text: "Added a test that fails on the broken code." }
      : { tools: [{ name: "write", args: { path: "tests/check.sh", content: "grep -q fixed sum.js\n" } }] };
    if (prompt.includes(REVIEW)) return TICKED;
    return afterTool(payload) ? { text: "Fixed sum.js." } : { tools: [{ name: "write", args: { path: "sum.js", content: "fixed\n" } }] };
  });
  await weaklyTestedProject(f);
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
}, 60_000);

test("a fix no test proves is not verified: the receipt says why, and --require-verification exits 3", async () => {
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
}, 60_000);

test("a feature worded like a test task is still reviewed and proven; a docs-only edit is not", async () => {
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
  // The checks passed; the docs edit was not proven, so the outcome is not verified (and --require-verification exits 3).
  expect({ checksPassed: docsReceipt.checksPassed, exit: documented.exit }).toEqual({ checksPassed: true, exit: 0 });
  expect(docs.payloads.some((payload) => lastUser(payload).includes(REVIEW))).toBe(false);
}, 90_000);

test("the review round runs even after a fully ticked first checklist, and the receipt keeps the review's", async () => {
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
}, 60_000);

test("the review round is off by default (and with verification.review: false); the change is still proven", async () => {
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
}, 60_000);
