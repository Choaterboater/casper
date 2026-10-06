import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import type { VerificationResult } from "./evidence";

/**
 * End-to-end tests the project already has (Playwright): found from its own files each time it is opened, never
 * cached, and run as the `e2e` check next to typecheck, lint, test and build. Casper never installs Playwright or
 * its browsers: when they are missing the check only skips and says how to get them. A project that names its own
 * `e2e` check under verify.checks keeps it, and `verification.e2e: false` (/settings) turns the found one off.
 */
export const E2E_CHECK = "e2e";

export interface E2ePlan {
  /** The command the check runs, at the project root. */
  command: string;
  /** node_modules/@playwright/test is there. Without it the check only skips. */
  installed: boolean;
  /** Where it was found, for /project and the docs: "the test:e2e script" or "playwright.config.ts". */
  source: string;
}

const SCRIPTS = ["test:e2e", "e2e", "test:playwright", "playwright"];
const CONFIGS = ["playwright.config.ts", "playwright.config.js", "playwright.config.mts", "playwright.config.mjs", "playwright.config.cjs"];

async function isFile(file: string): Promise<boolean> {
  return (await lstat(file).catch(() => undefined))?.isFile() ?? false;
}

/** The project's Playwright tests, or undefined: no @playwright/test, no script or config, or `test` runs them already. */
export async function detectE2e(root: string, packageManager: string | null): Promise<E2ePlan | undefined> {
  let manifest: Record<string, unknown>;
  try { manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as Record<string, unknown>; }
  catch { return undefined; }
  const block = (key: string) => (manifest[key] && typeof manifest[key] === "object" ? manifest[key] : {}) as Record<string, unknown>;
  if (!["dependencies", "devDependencies", "optionalDependencies"].some((key) => Object.hasOwn(block(key), "@playwright/test"))) return undefined;
  const scripts = block("scripts");
  // The test check already runs them: a second e2e check would run the same suite twice.
  if (typeof scripts.test === "string" && /\bplaywright\b/.test(scripts.test)) return undefined;
  const installed = (await lstat(path.join(root, "node_modules/@playwright/test")).catch(() => undefined))?.isDirectory() ?? false;
  const script = SCRIPTS.find((name) => typeof scripts[name] === "string" && (scripts[name] as string).trim());
  const runner = packageManager && ["bun", "npm", "pnpm", "yarn"].includes(packageManager) ? packageManager : "npm";
  if (script) return { command: `${runner} run ${script}`, installed, source: `the ${script} script` };
  for (const config of CONFIGS) {
    if (await isFile(path.join(root, config))) return { command: "npx --no-install playwright test", installed, source: config };
  }
  return undefined;
}

/** The found e2e check, unless the project named its own check `e2e`. */
export function detectedE2e(model: { e2e?: E2ePlan; namedChecks?: Record<string, unknown> }): E2ePlan | undefined {
  return model.e2e && !model.namedChecks?.[E2E_CHECK] ? model.e2e : undefined;
}

/** Why an e2e check Casper can't run only skips. */
export function e2eNotInstalled(packageManager: string | null): string {
  const install = packageManager && ["bun", "pnpm", "yarn"].includes(packageManager) ? `${packageManager} install` : "npm install";
  return `Playwright isn't installed here (node_modules/@playwright/test is missing). Run ${install} first; Casper doesn't install packages`;
}

const BROWSERS_MISSING = /Executable doesn't exist|npx playwright install|Please run the following command to download new browsers/i;

/** A run whose browsers were never downloaded is a skip that says so, not a failure for the AI to fix (it would
 * try to download them). Any other result is kept as it is. */
export function e2eResult(result: VerificationResult): VerificationResult {
  if (result.status !== "fail" || !BROWSERS_MISSING.test(`${result.stdout}\n${result.stderr}`)) return result;
  return { ...result, status: "skip", repair: "never", reason: "Playwright's browsers aren't downloaded. Run npx playwright install yourself; Casper doesn't download browsers" };
}
