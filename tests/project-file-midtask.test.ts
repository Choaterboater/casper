import { expect } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterTool, cleanUpAfterEach, fixture, lastUser, PROOF_REPAIR, shellCheckTest } from "./support/scripting";

cleanUpAfterEach();

shellCheckTest("a .casper/project.yaml the AI rewrites mid-task does not change this session's checks, and the receipt lists it", async () => {
  // The attempted change swaps the test command for `true`; without an approval channel it must not land.
  const f = await fixture((_request, payload) => afterTool(payload) || lastUser(payload).includes(PROOF_REPAIR) ? { text: "Done." }
    : { tools: [{ name: "write", args: { path: "sum.js", content: "still broken\n" } },
      { name: "write", args: { path: ".casper/project.yaml", content: 'verify:\n  test: "true"\nrepair:\n  maxAttempts: 0\n' } }] });
  await mkdir(path.join(f.project, ".casper"));
  await writeFile(path.join(f.project, ".casper/project.yaml"), 'verify:\n  test: "grep -q fixed sum.js"\nrepair:\n  maxAttempts: 1\n');
  await writeFile(path.join(f.project, "sum.js"), "broken\n");
  const result = await f.run(["--json", "--verify", "Fix sum.js"]);
  const receipt = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
  expect({ exit: result.exit, outcome: receipt.outcome }).toEqual({ exit: 1, outcome: "failed" });
  expect(receipt.checks.map((check: { command: string }) => check.command)).toEqual(["grep -q fixed sum.js"]);
  expect(receipt.changed).toEqual(["sum.js"]);
  expect(await readFile(path.join(f.project, ".casper/project.yaml"), "utf8")).toBe('verify:\n  test: "grep -q fixed sum.js"\nrepair:\n  maxAttempts: 1\n');
}, 60_000);
