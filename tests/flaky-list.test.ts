import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { tries } from "./support/platform";

/**
 * A retry can hide a real failure, so every one is a choice made in this file. These are the known flaky tests:
 * each drives a real child process that is sometimes too slow on one OS's CI runner, and gets one more try there
 * through flakyOn (tests/support/platform.ts). Adding a test here is the only way to make a test retry.
 */
const KNOWN_FLAKY: Array<[file: string, title: string, platforms: NodeJS.Platform[]]> = [
  ["tests/auto-builders.test.ts", "the AI starts two builders at once; both changes land, count as the task's edits, and one /undo takes them back", ["win32"]],
  ["tests/auto-builders.test.ts", "at most 3 builders at once; a fourth is turned away and not counted", ["win32"]],
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

/** A retry that would never be on the list: Bun's own retry option, whatever its count is written as (Pi's retry
 * settings, an object, and a `retry` variable's type are not it), or flakyOn's two tries called straight. */
function retriesOffTheList(source: string): boolean {
  return /(?<!\b(?:let|const|var)\s+)\bretry\s*:(?!\s*\{)/.test(source) || /\btries\(/.test(source);
}

test("a test retries only through flakyOn, and only the known flaky tests listed here, on the OS each one flakes on", () => {
  const direct: string[] = [];
  const found: Array<[string, string, string[]]> = [];
  for (const { file, source } of testSources()) {
    if (file === THIS_FILE || file === HELPER) continue;
    if (retriesOffTheList(source)) direct.push(file);
    for (const line of source.split("\n")) {
      if (!/\bflakyOn\(/.test(line) || /^import /.test(line)) continue;
      // Each use opens its test on the same line: flakyOn("win32")("title", ...
      const call = /^flakyOn\(([^)]*)\)\((["'`])(.+?)\2, /.exec(line);
      found.push(call ? [file, call[3]!, [...call[1]!.matchAll(/["'](\w+)["']/g)].map((match) => match[1]!)] : [file, line.trim(), []]);
    }
  }
  expect(direct).toEqual([]);
  expect(found.sort()).toEqual([...KNOWN_FLAKY].sort());
});

test("the guard sees Bun's retry option however its count is written, and a test built on tries directly", () => {
  for (const text of ["{ retry: 3 }", "{ retry: count }", "{ retry: Number(\"3\") }", "test(\"t\", body, {retry:MAX})",
    "const run = tries([\"win32\"], \"t\", body, 1000);\ntest(\"t\", run.body, run.timeout);"]) expect(retriesOffTheList(text)).toBe(true);
  for (const text of ["JSON.stringify({ retry: { enabled: false } })", "let retry: ReturnType<SettingsManager[\"getRetrySettings\"]> | undefined;", "const retryCount = 1;",
    "flakyOn(\"win32\")(\"t\", async () => {}, 1000);", "entries()"]) {
    expect(retriesOffTheList(text)).toBe(false);
  }
});

describe("flakyOn's two tries", () => {
  const here = process.platform;
  const other: NodeJS.Platform = here === "win32" ? "darwin" : "win32";
  let warned: string[] = [];
  let warn: ReturnType<typeof spyOn> | undefined;
  beforeEach(() => { warned = []; warn = spyOn(console, "warn").mockImplementation((line: string) => { warned.push(line); }); });
  afterEach(() => warn?.mockRestore());

  test("on any other OS the test is just as written: one try, its own limit", async () => {
    let runs = 0;
    const body = async () => { runs++; throw new Error("real failure"); };
    expect(tries([other], "t", body, 500)).toEqual({ body, timeout: 500 });
    expect(tries([], "t", body, 500)).toEqual({ body, timeout: 500 });
    await expect(tries([other], "t", body, 500).body()).rejects.toThrow("real failure");
    expect(runs).toBe(1);
    expect(warned).toEqual([]);
  });

  test("on the named OS a first try that runs out of time is tried once more, says so, and the limit covers both tries", async () => {
    let runs = 0;
    const run = tries([here], "t", async () => { if (++runs === 1) await new Promise(() => {}); }, 100);
    expect(run.timeout).toBeGreaterThanOrEqual(200);
    await run.body();
    expect(runs).toBe(2);
    expect(warned).toEqual(["(retry) t: the first try failed, trying once more: Error: timed out after 100ms"]);
  });

  test("a wrong result on the first try fails the test at once: it is never tried again", async () => {
    let runs = 0;
    const leak = tries([here], "t", async () => { runs++; expect(runs === 1 ? "secret-leaked" : "clean").toBe("clean"); }, 500);
    await expect(leak.body()).rejects.toThrow("secret-leaked");
    expect(runs).toBe(1);
    await expect(tries([here], "t", async () => { throw new Error(`failure ${++runs}`); }, 500).body()).rejects.toThrow("failure 2");
    expect(runs).toBe(2);
    expect(warned).toEqual([]);
  });

  test("a second failure fails the test with its own error", async () => {
    let runs = 0;
    await expect(tries([here], "t", async () => { if (++runs === 1) await new Promise(() => {}); throw new Error(`failure ${runs}`); }, 100).body()).rejects.toThrow("failure 2");
    expect(runs).toBe(2);
  });

  test("a first try that times out and then fails late cannot fail the second try", async () => {
    // The first try's child is killed by its own guard after the try's limit, and its check then fails.
    let killed!: () => void;
    const late = new Promise<void>((resolve) => { killed = resolve; });
    let runs = 0;
    const run = tries([here], "t", async () => {
      if (++runs === 2) { await late; return; }
      await new Promise((resolve) => setTimeout(resolve, 150));
      killed();
      throw new Error("exit 143");
    }, 100);
    await run.body();
    expect(runs).toBe(2);
    expect(warned).toEqual(["(retry) t: the first try failed, trying once more: Error: timed out after 100ms"]);
  });
});

test("nothing retries the whole suite: no --retry or --rerun-each in the scripts, bunfig or CI", () => {
  const files = ["package.json", "bunfig.toml", "tools/test-shard.ts", "tools/stall-guard.sh",
    ...readdirSync(path.join(ROOT, ".github", "workflows")).map((name) => `.github/workflows/${name}`)];
  const found = files.filter((file) => /--retry\b|--rerun-each\b|^\s*retry\s*=/m.test(readFileSync(path.join(ROOT, file), "utf8")));
  expect(found).toEqual([]);
});
