import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { flakyOn } from "./support/platform";

/**
 * A retry can hide a real failure, so every one is a choice made in this file. These are the known flaky tests:
 * each drives a real child process that is sometimes too slow on one OS's CI runner, and gets one more try there
 * through flakyOn (tests/support/platform.ts). Adding a test here is the only way to make a test retry.
 */
const KNOWN_FLAKY: Array<[file: string, title: string, platforms: NodeJS.Platform[]]> = [
  ["tests/auto-builders.test.ts", "the AI starts two builders at once; both changes land, count as the task's edits, and one /undo takes them back", ["win32"]],
  ["tests/auto-builders.test.ts", "at most 3 builders at once; a fourth is turned away and not counted", ["win32"]],
  ["tests/browser-metadata.test.ts", "opening a metadata address asks once; a no leaves it unopened and nobody to ask is a no", ["darwin"]],
  ["tests/browser-metadata.test.ts", "a yes opens it; a redirect there asks first and then follows", ["darwin"]],
  ["tests/browser-metadata.test.ts", "a no to a redirect, a picture, a frame or a fetch there keeps them all from reaching it, one question each time", ["darwin"]],
  ["tests/browser-metadata.test.ts", "a page check whose URL is a metadata address asks before it loads", ["darwin"]],
  ["tests/browser-metadata.test.ts", "the automatic page check is not the AI's browser: its pages load as before, with no question and no block", ["darwin"]],
  ["tests/cli-flags.test.ts", "--verify --no-verify is rejected before any work starts", ["win32"]],
  ["tests/eval-notes-server.test.ts", "the lifecycle task's hidden acceptance passes on the solved fixture and fails on its start, leaving no server behind", ["win32"]],
  ["tests/login.test.ts", "API-key login verifies with the provider, keeps secrets off screen, and preserves unrelated credentials", ["win32"]],
  ["tests/login.test.ts", "Copilot device login discloses account policy changes and saves only Copilot", ["win32"]],
  ["tests/login.test.ts", "API-key replacement refreshes the selected non-Codex parent without changing its conversation selection", ["win32"]],
  ["tests/login.test.ts", "provider refusal and occupied browser port expose no diagnostics and preserve existing credentials", ["win32"]],
  ["tests/login.test.ts", "CASPER_TUI_WRITE_LOG refuses login before terminal or auth ownership", ["win32"]],
  ["tests/login.test.ts", "CASPER_OAUTH_CALLBACK_HOST cannot expose browser sign-in on a public listener", ["win32"]],
  ["tests/phase5-lsp-real.test.ts", "real Pyright acceptance: repository-wide rename finishes with fresh zero diagnostics", ["win32"]],
];

const ROOT = path.resolve(import.meta.dir, "..");
const HELPER = "tests/support/platform.ts";
const THIS_FILE = "tests/flaky-list.test.ts";

function testSources(): Array<{ file: string; source: string }> {
  return (readdirSync(path.join(ROOT, "tests"), { recursive: true }) as string[])
    .filter((name) => /\.(c|m)?(j|t)sx?$/.test(name))
    .map((name) => `tests/${name.split(path.sep).join("/")}`)
    .filter((file) => file !== HELPER)
    .map((file) => ({ file, source: readFileSync(path.join(ROOT, file), "utf8") }));
}

test("a test retries only through flakyOn, and only the known flaky tests listed here, on the OS each one flakes on", () => {
  const direct: string[] = [];
  const found: Array<[string, string, string[]]> = [];
  for (const { file, source } of testSources()) {
    // Bun's own option written out with a count; Pi's retry settings and a `retry` variable's type are not.
    if (/\bretry\s*:\s*\d/.test(source)) direct.push(file);
    if (file === THIS_FILE) continue;
    const lines = source.split("\n");
    lines.forEach((line, index) => {
      const call = /\bflakyOn\(([^)]*)\)/.exec(line);
      if (!call) return;
      // The test this call closes: the nearest test opening above it, at the start of a line.
      let title = "";
      for (let at = index; at >= 0 && !title; at--) title = /^[\w.]+\((["'`])(.+?)\1, /.exec(lines[at]!)?.[2] ?? "";
      found.push([file, title, [...call[1]!.matchAll(/["'](\w+)["']/g)].map((match) => match[1]!)]);
    });
  }
  expect(direct).toEqual([]);
  expect(found.sort()).toEqual([...KNOWN_FLAKY].sort());
});

test("flakyOn gives one more try on the named OS and nothing elsewhere", () => {
  const other: NodeJS.Platform = process.platform === "win32" ? "darwin" : "win32";
  expect(flakyOn(process.platform).retry).toBe(1);
  expect(flakyOn(other)).toEqual({});
  expect(flakyOn()).toEqual({});
});

test("nothing retries the whole suite: no --retry or --rerun-each in the scripts, bunfig or CI", () => {
  const files = ["package.json", "bunfig.toml", "tools/test-shard.ts", "tools/stall-guard.sh",
    ...readdirSync(path.join(ROOT, ".github", "workflows")).map((name) => `.github/workflows/${name}`)];
  const found = files.filter((file) => /--retry\b|--rerun-each\b|^\s*retry\s*=/m.test(readFileSync(path.join(ROOT, file), "utf8")));
  expect(found).toEqual([]);
});
