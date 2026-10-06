import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadProjectContext } from "../src/project/context";
import type { ProjectModel } from "../src/project/model";
import { detectE2e, E2E_CHECK, e2eResult } from "../src/verify/e2e";
import { autoDetectedChecks } from "../src/verify/migrations-check";
import { planAutoChecks } from "../src/verify/mode";
import { defaultVerifyNames, VerifierRegistry } from "../src/verify/registry";
import { removeTempDir } from "./support/temp-dir";

/** Playwright end-to-end tests the project already has: found from its files, run as the `e2e` check. Casper never installs them. */

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((dir) => removeTempDir(dir))); });

async function project(files: Record<string, string>, installed = false): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-e2e-"));
  temporary.push(root);
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  if (installed) await mkdir(path.join(root, "node_modules/@playwright/test"), { recursive: true });
  return root;
}

const pkg = (scripts: Record<string, string>, dev: Record<string, string> = { "@playwright/test": "^1.50.0" }) =>
  JSON.stringify({ name: "app", scripts, devDependencies: dev });

function model(e2e?: ProjectModel["e2e"], root = "/tmp/app"): ProjectModel {
  return { schemaVersion: 1, project: { name: "app", root, git: false }, languages: ["typescript"], frameworks: [], packageManager: "bun",
    commands: { test: "bun test" }, architecture: {}, conventions: [], detectedAt: "2026-01-01T00:00:00.000Z", ...(e2e ? { e2e } : {}) } as ProjectModel;
}

test("an e2e script with Playwright installed is the e2e check, run with the project's package manager", async () => {
  const root = await project({ "package.json": pkg({ test: "bun test", "test:e2e": "playwright test" }) }, true);
  expect(await detectE2e(root, "bun")).toEqual({ command: "bun run test:e2e", installed: true, source: "the test:e2e script" });
  expect(await detectE2e(root, "npm")).toMatchObject({ command: "npm run test:e2e" });
});

test("a playwright.config with no script runs playwright test through npx, never installing it", async () => {
  const root = await project({ "package.json": pkg({ test: "vitest" }), "playwright.config.ts": "export default {}\n" }, true);
  expect(await detectE2e(root, "pnpm")).toEqual({ command: "npx --no-install playwright test", installed: true, source: "playwright.config.ts" });
});

test("nothing is found without Playwright, when test already runs it, or with no script or config", async () => {
  expect(await detectE2e(await project({ "package.json": pkg({ e2e: "cypress run" }, { cypress: "^13" }) }), "npm")).toBeUndefined();
  expect(await detectE2e(await project({ "package.json": pkg({ test: "playwright test", "test:e2e": "playwright test" }), "playwright.config.ts": "" }, true), "npm")).toBeUndefined();
  expect(await detectE2e(await project({ "package.json": pkg({ test: "bun test" }) }, true), "bun")).toBeUndefined();
  expect(await detectE2e(await project({}), "bun")).toBeUndefined();
});

test("Playwright not installed: found, but it only skips and says why; it never runs on its own", async () => {
  const root = await project({ "package.json": pkg({ "test:e2e": "playwright test" }) });
  const found = (await detectE2e(root, "bun"))!;
  expect(found.installed).toBe(false);
  const registry = VerifierRegistry.forProject(model(found, root));
  expect(registry.has(E2E_CHECK)).toBe(true);
  expect(registry.modelNames()).not.toContain(E2E_CHECK);
  const [result] = await registry.run([E2E_CHECK]);
  expect(result).toMatchObject({ status: "skip", repair: "never", reason: "Playwright isn't installed here (node_modules/@playwright/test is missing). Run bun install first; Casper doesn't install packages" });
  expect(autoDetectedChecks(model(found))).toEqual([]);
  expect(defaultVerifyNames(model(found))).not.toContain(E2E_CHECK);
});

test("installed: it runs after each change with the other checks, through /verify and the AI's casper_check", async () => {
  const root = await project({});
  const found = { command: "echo 3 passed", installed: true, source: "the e2e script" };
  const registry = VerifierRegistry.forProject(model(found, root));
  expect(registry.modelNames()).toContain(E2E_CHECK);
  expect(registry.command(E2E_CHECK)).toBe("echo 3 passed");
  const [result] = await registry.run([E2E_CHECK]);
  expect(result).toMatchObject({ name: E2E_CHECK, status: "pass" });
  expect(autoDetectedChecks(model(found)).map(({ name }) => name)).toEqual([E2E_CHECK]);
  expect(defaultVerifyNames(model(found))).toContain(E2E_CHECK);
  const planned = planAutoChecks({ commands: { test: "bun test" }, detected: autoDetectedChecks(model(found)), changedPaths: ["src/App.tsx"] });
  expect(planned.run).toEqual(["test", E2E_CHECK]);
});

test("missing Playwright browsers are a skip that says how to get them, never a failure for the AI to fix", () => {
  const base = { name: E2E_CHECK, cwd: "/tmp/app", command: "bun run test:e2e", exitCode: 1, signal: null, truncated: false, durationMs: 900 } as const;
  const missing = e2eResult({ ...base, status: "fail", stdout: "", stderr: "browserType.launch: Executable doesn't exist at /x/chrome-linux/chrome\nLooks like Playwright was just installed or updated.\nPlease run the following command to download new browsers:\n    npx playwright install" });
  expect(missing).toMatchObject({ status: "skip", repair: "never", reason: "Playwright's browsers aren't downloaded. Run npx playwright install yourself; Casper doesn't download browsers" });
  const failed = e2eResult({ ...base, status: "fail", stdout: "1 failed\n  login.spec.ts:4 signs in", stderr: "" });
  expect(failed.status).toBe("fail");
  expect(failed.repair).toBeUndefined();
});

test("the project's own e2e check wins, and verification.e2e: false turns the found one off", async () => {
  const files = { "package.json": pkg({ "test:e2e": "playwright test" }), "bun.lock": "" };
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-e2e-home-"));
  temporary.push(home);
  const root = await project(files, true);
  const info = { cwd: root, root, name: "app", gitBranch: null, isGit: false };
  expect((await loadProjectContext(info, { homeDir: home })).model.e2e).toMatchObject({ command: "bun run test:e2e", installed: true });
  await mkdir(path.join(root, ".casper"));
  await writeFile(path.join(root, ".casper/project.yaml"), "verification:\n  e2e: false\n");
  expect((await loadProjectContext(info, { homeDir: home })).model.e2e).toBeUndefined();
  await writeFile(path.join(root, ".casper/project.yaml"), "verify:\n  checks:\n    e2e: { run: bun run test:e2e -- --project=chromium }\n");
  const own = await loadProjectContext(info, { homeDir: home });
  expect(own.model.e2e).toBeUndefined();
  expect(own.model.namedChecks?.e2e?.run).toBe("bun run test:e2e -- --project=chromium");
});
