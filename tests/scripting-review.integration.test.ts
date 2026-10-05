import { expect, test } from "bun:test";
import { appendFile, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { cleanUpAfterEach, fixture, events, fixProject, lastUser, afterTool, REVIEW, reviewOn, PROOF_REPAIR, weaklyTestedProject, asked, TICKED, isAcceptance, isChecklist, endlessReview, shellCheckTest } from "./support/scripting";

cleanUpAfterEach();

test("verification.acceptance: tests written from the request alone decide between verified and not verified, and are never kept", async () => {
  const accepting = (assertion: string) => fixture((_request, payload) => isAcceptance(payload)
    ? { text: `\`\`\`js\nimport { expect, test } from "bun:test";\nimport { value } from "../src/value.js";\ntest("\\"value is FIXED\\"", () => { ${assertion}; });\n\`\`\`` }
    : afterTool(payload) ? { text: "Fixed." } : { tools: [{ name: "write", args: { path: "src/value.js", content: "export const value = \"FIXED\";\n" } }] });
  const setUp = async (f: Awaited<ReturnType<typeof fixture>>, setting = "true") => {
    await mkdir(path.join(f.project, ".casper"));
    await mkdir(path.join(f.project, "src"));
    await mkdir(path.join(f.project, "tests"));
    await writeFile(path.join(f.project, ".casper/project.yaml"), `verify:\n  test: ${JSON.stringify(`"${process.execPath}" test`)}\nverification:\n  acceptance: ${setting}\n`);
    await writeFile(path.join(f.project, "src/value.js"), "export const value = \"BROKEN\";\n");
    await writeFile(path.join(f.project, "tests/value.test.js"), "import { expect, test } from \"bun:test\";\nimport { value } from \"../src/value.js\";\ntest(\"value\", () => expect(value).toBe(\"FIXED\"));\n");
  };

  const rejected = await accepting("expect(value).toBe(\"OTHER\")");
  await setUp(rejected);
  const failed = await rejected.run(["--json", "--verify", "--require-verification", "Make value FIXED"]);
  const failedReceipt = JSON.parse(failed.stdout.trim().split("\n").at(-1)!);
  // Proven by the project's tests, then rejected by the request's: not verified, exit 3 when verification is required.
  expect({ exit: failed.exit, outcome: failedReceipt.outcome, proof: failedReceipt.proof?.status, acceptance: failedReceipt.acceptance?.status })
    .toEqual({ exit: 3, outcome: "not_verified", proof: "proven", acceptance: "fail" });
  expect(failedReceipt.acceptance.unconfirmed).toEqual(["\"value is FIXED\""]);
  expect(failedReceipt.text).toContain("✗ Independent acceptance: tests written from the request alone fail: \"value is FIXED\"");
  // Two task responses and the acceptance call, 120 tokens each: the separate call is in the task's usage.
  expect(rejected.payloads.filter(isAcceptance)).toHaveLength(1);
  expect(failedReceipt.usage.tokens).toBe(360);
  expect(await readdir(path.join(rejected.project, "tests"))).toEqual(["value.test.js"]);

  const approved = await accepting("expect(value).toBe(\"FIXED\")");
  await setUp(approved);
  const passed = await approved.run(["--json", "--verify", "--require-verification", "Make value FIXED"]);
  const passedReceipt = JSON.parse(passed.stdout.trim().split("\n").at(-1)!);
  expect({ exit: passed.exit, outcome: passedReceipt.outcome, acceptance: passedReceipt.acceptance }).toEqual({ exit: 0, outcome: "verified", acceptance: { status: "pass", mode: "verdict" } });

  // With a review role, the acceptance tests come from that model, not the one that did the work.
  const crossed = await accepting("expect(value).toBe(\"FIXED\")");
  await setUp(crossed);
  await writeFile(crossed.settings, JSON.stringify({ defaultProvider: "fixture", defaultModel: "first", retry: { enabled: false }, modelRoles: { review: "fixture/second" } }));
  const crossedReceipt = JSON.parse((await crossed.run(["--json", "--verify", "Make value FIXED"])).stdout.trim().split("\n").at(-1)!);
  expect(crossedReceipt.acceptance).toEqual({ status: "pass", mode: "verdict" });
  expect(crossed.payloads.map((payload) => [isAcceptance(payload), payload.model])).toEqual([[false, "first"], [false, "first"], [true, "second"]]);

  // warn: a request Casper does not prove (intent configure) is still checked, and a failure only names
  // what the request's tests did not confirm. Not proven, so not verified: exit 3 when verification is required.
  const warned = await accepting("expect(value).toBe(\"OTHER\")");
  await setUp(warned, "warn");
  const warnedRun = await warned.run(["--json", "--verify", "--require-verification", "Configure value to be FIXED"]);
  const warnedReceipt = JSON.parse(warnedRun.stdout.trim().split("\n").at(-1)!);
  expect({ exit: warnedRun.exit, outcome: warnedReceipt.outcome, proof: warnedReceipt.proof, acceptance: { ...warnedReceipt.acceptance, output: undefined } })
    .toEqual({ exit: 3, outcome: "not_verified", proof: null, acceptance: { status: "fail", mode: "warn", unconfirmed: ["\"value is FIXED\""], output: undefined } });
  expect(warnedReceipt.text).toContain("⚠ Not confirmed by tests written from the request: \"value is FIXED\"");
}, 180_000);

shellCheckTest("verification.checklist: a separate call lists the request's cases first; the task prompt asks for one test per case", async () => {
  const listing = (answer: string) => fixture((_request, payload) => isChecklist(payload) ? { text: answer }
    : afterTool(payload) ? { text: "Fixed." } : { tools: [{ name: "write", args: { path: "sum.js", content: "fixed\n" } }] });
  const checklistOn = (f: Awaited<ReturnType<typeof fixture>>) => appendFile(path.join(f.project, ".casper/project.yaml"), "verification:\n  checklist: true\n");

  const listed = await listing("The cases:\n```json\n[\"sum.js prints fixed\", \"sum(2, 3) returns 5\"]\n```");
  await fixProject(listed);
  await checklistOn(listed);
  const result = await listed.run(["--json", "--verify", "Fix sum.js: it prints fixed and sum(2, 3) returns 5"]);
  const receipt = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
  expect({ exit: result.exit, outcome: receipt.outcome, checklist: receipt.checklist })
    .toEqual({ exit: 0, outcome: "verified", checklist: ["sum.js prints fixed", "sum(2, 3) returns 5"] });
  // Made quietly: the cases reach the model and the JSON receipt, not the transcript before work.
  expect(result.stderr).not.toContain("Casper checklist");
  expect(result.stderr).not.toContain("- sum.js prints fixed");
  // The checklist call comes first, outside the conversation; its usage joins the task's (3 × 120 tokens).
  expect(listed.payloads.map(isChecklist)).toEqual([true, false, false]);
  expect(asked(listed.payloads[0], "Fix sum.js: it prints fixed and sum(2, 3) returns 5")).toBe(true);
  expect(lastUser(listed.payloads[1])).toContain("write one test per case that asserts exactly that case:\\n- sum.js prints fixed\\n- sum(2, 3) returns 5");
  expect(receipt.usage.tokens).toBe(360);
  const phases = events(result.stdout, await realpath(listed.project)).filter((event) => event.type === "phase").map((event) => `${event.phase}:${event.state}`);
  expect(phases.slice(0, 3)).toEqual(["checklist:start", "checklist:end", "task:start"]);

  // An answer with no list is one line; the task goes on without a checklist.
  const unlisted = await listing("The request states no cases.");
  await fixProject(unlisted);
  await checklistOn(unlisted);
  const failed = await unlisted.run(["--json", "--verify", "Fix sum.js"]);
  const failedReceipt = JSON.parse(failed.stdout.trim().split("\n").at(-1)!);
  expect({ exit: failed.exit, outcome: failedReceipt.outcome, checklist: failedReceipt.checklist }).toEqual({ exit: 0, outcome: "verified", checklist: null });
  expect(failed.stderr).toContain("• Checklist not made: the checklist answer had no list of cases\n");
  expect(lastUser(unlisted.payloads[1])).not.toContain("Casper's checklist");

  // Off by default: no extra call.
  const off = await listing("[\"never asked\"]");
  await fixProject(off);
  const plain = JSON.parse((await off.run(["--json", "--verify", "Fix sum.js"])).stdout.trim().split("\n").at(-1)!);
  expect({ outcome: plain.outcome, checklist: plain.checklist }).toEqual({ outcome: "verified", checklist: null });
  expect(off.payloads.some(isChecklist)).toBe(false);
}, 120_000);

shellCheckTest("the review round fixes a gap the model finds; a gap it admits keeps the change unverified", async () => {
  // The review finds that sum.js also needs a newline marker and fixes it; the checks rerun and pass.
  const fixed = await fixture((_request, payload) => {
    const prompt = lastUser(payload);
    // The delta answer: only the gap it fixed, and the count.
    if (prompt.includes(REVIEW)) return afterTool(payload) ? { text: "Requirements review:\n- [x] marker — test\nCovered: 2 of 2 requirements." }
      : { tools: [{ name: "write", args: { path: "sum.js", content: "fixed marker\n" } }] };
    return afterTool(payload) ? { text: "Fixed." } : { tools: [{ name: "write", args: { path: "sum.js", content: "fixed\n" } }] };
  });
  await fixProject(fixed);
  await reviewOn(fixed);
  const reviewed = await fixed.run(["--json", "--verify", "Fix sum.js"]);
  const receipt = JSON.parse(reviewed.stdout.trim().split("\n").at(-1)!);
  expect({ exit: reviewed.exit, outcome: receipt.outcome, review: receipt.review, proof: receipt.proof?.status })
    .toEqual({ exit: 0, outcome: "verified", review: { fixed: ["marker — test"], open: [], covered: 2, total: 2 }, proof: "proven" });
  expect(receipt.text).toContain("• The model's review: all 2 requirements covered (1 gap fixed; its own claim, not checked by Casper)");
  expect(await readFile(path.join(fixed.project, "sum.js"), "utf8")).toBe("fixed marker\n");

  const admitted = await fixture((_request, payload) => lastUser(payload).includes(REVIEW)
    ? { text: "Requirements:\n- [x] sum.js is fixed — test\n- [ ] negative numbers — not implemented" }
    : afterTool(payload) ? { text: "Fixed." } : { tools: [{ name: "write", args: { path: "sum.js", content: "fixed\n" } }] });
  await fixProject(admitted);
  await reviewOn(admitted);
  const gap = await admitted.run(["--json", "--verify", "--require-verification", "Fix sum.js"]);
  const gapReceipt = JSON.parse(gap.stdout.trim().split("\n").at(-1)!);
  expect({ exit: gap.exit, outcome: gapReceipt.outcome }).toEqual({ exit: 3, outcome: "not_verified" });
  expect(gapReceipt.text).toContain("⚠ The model's review says not done: negative numbers — not implemented");
}, 120_000);

shellCheckTest("the review stops at its own 12-turn budget; Casper still reruns the checks and proves the change", async () => {
  const f = await fixture(endlessReview);
  await fixProject(f);
  await reviewOn(f);
  const result = await f.run(["--json", "--verify", "--require-verification", "Fix sum.js"]);
  expect(f.payloads.filter((payload) => lastUser(payload).includes(REVIEW)).length).toBe(12);
  const stream = events(result.stdout, "");
  const receipt = stream.at(-1);
  // The review edited files, so the checks ran again; then the proof. Not the task's own --max-turns stop.
  expect(stream.filter((event) => event.type === "check").length).toBe(2);
  expect({ exit: result.exit, outcome: receipt.outcome, turnLimit: receipt.turnLimit, proof: receipt.proof?.status, review: receipt.review })
    .toEqual({ exit: 0, outcome: "verified", turnLimit: null, proof: "proven", review: { missing: true, incomplete: true } });
  expect(receipt.text).toContain("• The model's review stopped at its 12-turn budget (its own claim so far, not checked by Casper)");
  expect(receipt.text).not.toContain("--max-turns");
}, 60_000);

shellCheckTest("a --max-turns below the review's budget still stops the task in the review: no proof, exit 2", async () => {
  const f = await fixture(endlessReview);
  await fixProject(f);
  await reviewOn(f);
  const result = await f.run(["--json", "--verify", "--max-turns", "3", "Fix sum.js"]);
  expect(f.payloads.filter((payload) => lastUser(payload).includes(REVIEW)).length).toBe(3);
  const receipt = events(result.stdout, "").at(-1);
  expect({ exit: result.exit, outcome: receipt.outcome, turnLimit: receipt.turnLimit, proof: receipt.proof, review: receipt.review })
    .toEqual({ exit: 2, outcome: "incomplete", turnLimit: 3, proof: null, review: null });
  expect(receipt.text).toContain("• Incomplete — stopped after 3 turns (--max-turns)");
}, 60_000);

shellCheckTest("the proof repair round has the same 12-turn budget; the proof then decides", async () => {
  const f = await fixture((_request, payload) => {
    const prompt = lastUser(payload);
    if (prompt.includes(PROOF_REPAIR)) return { tools: [{ name: "write", args: { path: `proof-${payload.messages.length}.txt`, content: "x\n" } }] };
    if (prompt.includes(REVIEW)) return TICKED;
    return afterTool(payload) ? { text: "Fixed sum.js." } : { tools: [{ name: "write", args: { path: "sum.js", content: "fixed\n" } }] };
  });
  await weaklyTestedProject(f);
  const result = await f.run(["--json", "--verify", "--require-verification", "Fix sum.js"]);
  expect(f.payloads.filter((payload) => lastUser(payload).includes(PROOF_REPAIR)).length).toBe(12);
  const receipt = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
  expect({ exit: result.exit, outcome: receipt.outcome, turnLimit: receipt.turnLimit, proof: receipt.proof?.status })
    .toEqual({ exit: 3, outcome: "not_verified", turnLimit: null, proof: "unproven" });
}, 60_000);
