import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { planAutoChecks } from "../src/verify/mode";
import type { VerificationScope } from "../src/verify/scope";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function project(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-autoalias-")));
  roots.push(root);
  await mkdir(path.join(root, "src", "generated"), { recursive: true });
  await mkdir(path.join(root, "docs"));
  for (const file of ["src/index.ts", "src/generated/out.ts", "docs/readme.md"]) await writeFile(path.join(root, file), "x\n");
  return root;
}
const plan = (root: string | undefined, scope: VerificationScope, changedPaths: string[]) =>
  planAutoChecks({ commands: { test: "bun test" }, scopes: { test: scope }, changedPaths, ...(root ? { root } : {}) });

test("a check declared as SRC runs when src/index.ts changes on a volume that treats them as one folder", async () => {
  const root = await project();
  if (await realpath(path.join(root, "SRC")).catch(() => undefined) !== await realpath(path.join(root, "src"))) return; // case-sensitive volume
  expect(plan(root, { inputs: ["SRC"] }, ["src/index.ts"]).run).toEqual(["test"]);
});

test("a check on a symlinked spelling of the folder runs when the real folder changes", async () => {
  const root = await project();
  await symlink("src", path.join(root, "lib"));
  expect(plan(root, { inputs: ["lib"] }, ["src/index.ts"]).run).toEqual(["test"]);
});

test("editing a folder above a declared input runs the check", async () => {
  const root = await project();
  expect(plan(root, { inputs: ["src/generated"] }, ["src"]).run).toEqual(["test"]);
});

test("a declared input that does not exist yet is not proven unaffected by a different spelling", async () => {
  const root = await project();
  expect(plan(root, { inputs: ["Gen/out"] }, ["gen/out/a.ts"]).run).toEqual(["test"]);
});

test("an excluded path and an unrelated path still skip the check", async () => {
  const root = await project();
  const scope = { inputs: ["src"], exclude: ["src/generated"] };
  expect(plan(root, scope, ["src/generated/out.ts"])).toEqual({ run: [], skipped: "not-covered" });
  expect(plan(root, scope, ["docs/readme.md"])).toEqual({ run: [], skipped: "not-covered" });
  expect(plan(root, scope, ["docs/readme.md", "src/index.ts"]).run).toEqual(["test"]);
});

test("without a workspace root the literal comparison is unchanged", () => {
  expect(plan(undefined, { inputs: ["src"] }, ["src/index.ts"]).run).toEqual(["test"]);
  expect(plan(undefined, { inputs: ["src"] }, ["docs/readme.md"]).skipped).toBe("not-covered");
});
