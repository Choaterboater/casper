import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hiddenPaths, prepareWorkdir, type EvalTask } from "../evals/runner";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function owned(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("a setup removal ending in / deletes that whole directory from the candidate", async () => {
  const root = await owned("casper-eval-hidden-root-");
  await mkdir(path.join(root, "evals/fixtures/demo/acceptance/deep"), { recursive: true });
  await mkdir(path.join(root, "evals/setups/demo/files"), { recursive: true });
  await writeFile(path.join(root, "evals/fixtures/demo/keep.txt"), "kept");
  await writeFile(path.join(root, "evals/fixtures/demo/acceptance/deep/hidden.test.ts"), "secret");
  await writeFile(path.join(root, "evals/setups/demo/remove.json"), '["acceptance/"]');
  const task: EvalTask = { id: "demo", fixture: "demo", setup: "demo", prompt: "p", verify: [], candidatePaths: [], initialVerification: "fail", acceptance: {} };
  const workdir = await prepareWorkdir(task, root);
  cleanup.push(() => rm(workdir, { recursive: true, force: true }));
  expect(await readdir(workdir)).toEqual(["keep.txt"]);
  expect(await hiddenPaths(task, root)).toEqual(["acceptance/"]);
});
