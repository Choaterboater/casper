import { expect } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runOk } from "./support/run";
import { afterTool, cleanUpAfterEach, fixture, shellCheckTest } from "./support/scripting";

cleanUpAfterEach();

async function gitRepo(root: string) {
  const git = (...args: string[]) => runOk(["git", ...args], { cwd: root, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  await git("init", "-q"); await git("config", "user.email", "t@example.com"); await git("config", "user.name", "t");
  await git("add", "-A"); await git("commit", "-qm", "first");
}

shellCheckTest("a file the AI writes that git ignores is still a change: listed on the receipt, and the checks run", async () => {
  const f = await fixture((_request, payload) => afterTool(payload) ? { text: "Done." }
    : { tools: [{ name: "write", args: { path: "dist/feature.js", content: "export const x = 1;\n" } }] });
  await mkdir(path.join(f.project, ".casper"));
  await writeFile(path.join(f.project, ".casper/project.yaml"), 'verify:\n  test: "test -f sum.js"\n');
  await writeFile(path.join(f.project, ".gitignore"), "dist/\n");
  await writeFile(path.join(f.project, "sum.js"), "ok\n");
  await gitRepo(f.project);
  const result = await f.run(["--json", "--verify", "Add the feature build"]);
  const receipt = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
  expect(receipt.changed).toEqual(["dist/feature.js"]);
  expect(receipt.outcome).not.toBe("unchanged");
  expect(receipt.checks.map((check: { name: string }) => check.name)).toEqual(["test"]);
}, 60_000);

shellCheckTest("adding a file to .gitignore does not list it as changed when its bytes did not change", async () => {
  const f = await fixture((_request, payload) => afterTool(payload) ? { text: "Done." }
    : { tools: [{ name: "write", args: { path: ".gitignore", content: "notes.txt\n" } }] });
  await writeFile(path.join(f.project, ".gitignore"), "\n");
  await gitRepo(f.project);
  // Untracked: git lists it until the change ignores it.
  await writeFile(path.join(f.project, "notes.txt"), "mine\n");
  const result = await f.run(["--json", "--verify", "Ignore my notes"]);
  const receipt = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
  expect(receipt.changed).toEqual([".gitignore"]);
}, 60_000);
