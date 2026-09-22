import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveAutoVerify } from "../src/cli";
import { CASPER_VERSION } from "../src/version";
import { posixOnly } from "./support/platform";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");
const tempDirs: string[] = [];
afterEach(async () => { for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function run(args: string[], cwd: string) {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd, env: { ...process.env, HOME: cwd, CASPER_PROFILE: "default" }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, code };
}

test("interactive sessions offer casper_check unless --no-verify; one-shot prompts need --verify", () => {
  expect(resolveAutoVerify({ verify: false, noVerify: false, interactive: true })).toBe(true);
  expect(resolveAutoVerify({ verify: false, noVerify: true, interactive: true })).toBe(false);
  expect(resolveAutoVerify({ verify: false, noVerify: false, interactive: false })).toBe(false);
  expect(resolveAutoVerify({ verify: true, noVerify: false, interactive: false })).toBe(true);
  expect(() => resolveAutoVerify({ verify: true, noVerify: true, interactive: true })).toThrow("--verify and --no-verify cannot be combined");
});

test("--verify --no-verify is rejected before any work starts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-cli-flags-"));
  tempDirs.push(root);
  const result = await run([cli, "--verify", "--no-verify", "Summarize"], root);
  expect({ code: result.code, stdout: result.stdout }).toEqual({ code: 1, stdout: "" });
  expect(result.stderr).toContain("--verify and --no-verify cannot be combined");
});

posixOnly("--version names the cli.ts that actually runs, through a PATH-style symlink", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-cli-flags-"));
  tempDirs.push(root);
  const link = path.join(root, "casper");
  await symlink(cli, link);
  const result = await run([link, "--version"], root);
  expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
  expect(result.stdout).toBe(`casper ${CASPER_VERSION} (${await realpath(cli)})\n`);
});
