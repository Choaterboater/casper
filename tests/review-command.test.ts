import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SubagentResult } from "../src/agents/manager";
import { SUBAGENT_LIMITS } from "../src/agents/manager";
import { collectReviewDiff, resolveReviewTarget, REVIEW_USAGE, reviewContext, reviewGoal, runReview, type ReviewHost } from "../src/app/review-command";
import { COMMAND_REGISTRY, runsDuringWork } from "../src/tui/commands";
import { commandProblem, FULL_HELP_TEXT } from "../src/tui/help";
import { gitIn } from "./fixtures/security-tools/setup";
import { removeTempDir } from "./support/temp-dir";

const temps: string[] = [];
afterEach(async () => { for (const dir of temps.splice(0)) await removeTempDir(dir); });

/** A repo on main with one commit, then a branch `feature` with one more commit. */
async function repo(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-review-")));
  temps.push(root);
  await gitIn(root, "init", "-q");
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n");
  await gitIn(root, "add", "src/a.ts"); await gitIn(root, "commit", "-qm", "first");
  await gitIn(root, "checkout", "-qb", "feature");
  await writeFile(path.join(root, "src", "b.ts"), "export function b(x: number) {\n  return x / 0;\n}\n");
  await gitIn(root, "add", "src/b.ts"); await gitIn(root, "commit", "-qm", "second");
  return root;
}

interface Fake { host: ReviewHost; out: string[]; runs: { goal: string; context: string }[]; told: string[] }

function fake(root: string, response: string, status: SubagentResult["status"] = "completed"): Fake {
  const out: string[] = [];
  const runs: { goal: string; context: string }[] = [];
  const told: string[] = [];
  const host: ReviewHost = {
    root, write: (text) => out.push(text),
    run: async ({ goal, context }) => {
      runs.push({ goal, context });
      return { role: "reviewer", goal, cwd: root, status, response, toolsUsed: ["read"], toolErrors: [], truncated: false, usage: { tokens: 1200, estimatedCost: 0 } };
    },
    tell: async (note) => { told.push(note); },
  };
  return { host, out, runs, told };
}

test("/review takes nothing, a branch or a commit; a bad ref or extra words say how to use it", async () => {
  const root = await repo();
  expect((await resolveReviewTarget(root, [])).kind).toBe("uncommitted");
  const branch = await resolveReviewTarget(root, ["main"]);
  expect(branch).toMatchObject({ kind: "branch", label: "the changes since main" });
  const head = (await gitIn(root, "rev-parse", "HEAD")).trim();
  const commit = await resolveReviewTarget(root, [head.slice(0, 8)]);
  expect(commit).toMatchObject({ kind: "commit", sha: head, label: `commit ${head.slice(0, 12)}` });
  await expect(resolveReviewTarget(root, ["no-such-branch"])).rejects.toThrow("is not a branch or commit here");
  await expect(resolveReviewTarget(root, ["--output=x"])).rejects.toThrow(REVIEW_USAGE);
  await expect(resolveReviewTarget(root, ["main", "extra"])).rejects.toThrow(REVIEW_USAGE);
  const plain = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-review-plain-")));
  temps.push(plain);
  await expect(resolveReviewTarget(plain, [])).rejects.toThrow("needs a git repository");
});

test("the diff covers staged, unstaged and new files; key and .env files stay out", async () => {
  const root = await repo();
  await writeFile(path.join(root, "src", "a.ts"), "export const a = 2;\n");
  await writeFile(path.join(root, "src", "c.ts"), "export const c = 3;\n");
  await gitIn(root, "add", "src/c.ts");
  await writeFile(path.join(root, "src", "d.ts"), "export const d = 4;\n");
  await writeFile(path.join(root, ".env"), "TOKEN=x\n");
  const diff = await collectReviewDiff(root, await resolveReviewTarget(root, []));
  expect(diff.files).toEqual(["src/a.ts", "src/c.ts", "src/d.ts"]);
  expect(diff.leftOut).toEqual([{ file: ".env", why: "may hold secrets" }]);
  expect(diff.diff).toContain("+export const a = 2;");
  expect(diff.diff).toContain("+export const d = 4;");
  expect(diff.diff).not.toContain("TOKEN");
  // A branch: since its merge-base. A commit: that commit only.
  const since = await collectReviewDiff(root, await resolveReviewTarget(root, ["main"]));
  expect(since.files).toContain("src/b.ts");
  const one = await collectReviewDiff(root, await resolveReviewTarget(root, ["HEAD"]));
  expect(one.files).toEqual(["src/b.ts"]);
});

test("a big diff is capped and says which files were left out", async () => {
  const root = await repo();
  for (const name of ["x", "y", "z"]) await writeFile(path.join(root, "src", `${name}.ts`), `${"const v = 1;\n".repeat(200)}`);
  const diff = await collectReviewDiff(root, await resolveReviewTarget(root, []), 2000);
  expect(diff.files).toEqual(["src/x.ts"]);
  expect(diff.diff).toContain("cut off here");
  expect(diff.leftOut.map((item) => item.why)).toEqual(["past the size cap", "past the size cap"]);
});

test("many small files keep the reviewer's context within its limit", async () => {
  const root = await repo();
  const dir = path.join(root, "src", "components", "feature-area");
  await mkdir(dir, { recursive: true });
  for (let i = 0; i < 190; i++) await writeFile(path.join(dir, `SomeQuiteLongComponentName${i}.tsx`), "export const x = 1;\n");
  const target = await resolveReviewTarget(root, []);
  const diff = await collectReviewDiff(root, target);
  const context = reviewContext(target, diff);
  expect(Buffer.byteLength(context)).toBeLessThanOrEqual(SUBAGENT_LIMITS.partContextBytes);
  expect(context).toMatch(/and \d+ more/);
  // A diff that scrubbing made longer than the cap is cut, not refused.
  const grown = reviewContext(target, { ...diff, diff: "+x\n".repeat(20_000) });
  expect(Buffer.byteLength(grown)).toBeLessThanOrEqual(SUBAGENT_LIMITS.partContextBytes);
  expect(grown).toContain("[the diff is cut off here; read the files]");
});

test("an empty change asks no model", async () => {
  const root = await repo();
  const { host, out, runs } = fake(root, "[]");
  expect(await runReview(host, [])).toBeUndefined();
  expect(runs).toHaveLength(0);
  expect(out.join("")).toContain("Nothing to review: your uncommitted changes are empty. No model was asked.");
});

test("findings are numbered, a bad file:line is dropped, and the conversation is told the list", async () => {
  const root = await repo();
  await writeFile(path.join(root, ".env"), "TOKEN=x\n");
  const response = "```json\n" + JSON.stringify([
    { file: "src/b.ts", line: 2, kind: "bug", why: "Divides by zero." },
    { file: "src/b.ts", line: 99, kind: "bug", why: "No such line." },
    { file: "src/a.ts", line: 1, kind: "bug", why: "Not a changed file in this commit." },
    { file: ".env", line: 1, kind: "security", why: "Kept from the reviewer." },
    { file: "src/b.ts", line: 1, kind: "test", why: "No test covers b." },
  ]) + "\n```";
  const { host, out, runs, told } = fake(root, response);
  const kept = await runReview(host, ["HEAD"]);
  expect(kept?.map((finding) => `${finding.file}:${finding.line}`)).toEqual(["src/b.ts:2", "src/b.ts:1"]);
  const text = out.join("");
  expect(text).toContain("1. src/b.ts:2  bug: Divides by zero.");
  expect(text).toContain("2. src/b.ts:1  test: No test covers b.");
  expect(text).toContain("3 findings not shown: no real line in the changed files.");
  expect(text).toContain('"fix 1 and 2"');
  expect(runs[0]!.context).toContain("return x / 0;");
  expect(told).toHaveLength(1);
  expect(told[0]).toContain("1. src/b.ts:2 bug: Divides by zero.");
});

test("nothing found says so; the brief asks for bugs, security and tests, not style, and names the repo's rules", async () => {
  const root = await repo();
  await writeFile(path.join(root, "AGENTS.md"), "rules\n");
  await mkdir(path.join(root, "docs", "adr"), { recursive: true });
  await writeFile(path.join(root, "docs", "adr", "0002-deliberate-choices.md"), "choices\n");
  await gitIn(root, "add", "AGENTS.md", "docs/adr/0002-deliberate-choices.md");
  await writeFile(path.join(root, "src", "a.ts"), "export const a = 5;\n");
  const { host, out, runs, told } = fake(root, "```json\n[]\n```");
  expect(await runReview(host, [])).toEqual([]);
  expect(out.join("")).toContain("Nothing found.");
  expect(told).toHaveLength(0);
  const goal = runs[0]!.goal;
  expect(goal).toContain("No style");
  expect(goal).toContain("security issues");
  expect(goal).toContain("missing tests");
  expect(goal).toContain("AGENTS.md, docs/adr/0002-deliberate-choices.md");
  expect(Buffer.byteLength(reviewGoal({ kind: "uncommitted", label: "your uncommitted changes", base: "HEAD" }, ["AGENTS.md"]))).toBeLessThan(4096);
});

test("/review is in the table, waits for a running task, and is in /help all", () => {
  const spec = COMMAND_REGISTRY.find((command) => command.name === "review");
  expect(spec?.argumentHint).toBe("[branch|commit]");
  expect(runsDuringWork("/review")).toBe(false);
  expect(commandProblem("/review main")).toBeUndefined();
  expect(FULL_HELP_TEXT).toContain("  /review  ");
  expect(FULL_HELP_TEXT).toContain("  /review <branch|commit>  ");
});
