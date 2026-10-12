import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { finished } from "./support/limits";

// finished() in support/limits.ts: a child that printed nothing and had to be killed is started once more; nothing else is.
let warned: string[] = [];
let warn: ReturnType<typeof spyOn> | undefined;
let root = "";
beforeEach(async () => {
  warned = [];
  warn = spyOn(console, "warn").mockImplementation((line: string) => { warned.push(line); });
  root = await mkdtemp(path.join(os.tmpdir(), "casper-test-guard-"));
});
afterEach(async () => { warn?.mockRestore(); await rm(root, { recursive: true, force: true }); });

function counted(script: string, ...args: string[]) {
  const starts = { count: 0 };
  const start = () => { starts.count++; return Bun.spawn([process.execPath, "-e", script, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" }); };
  return { starts, start };
}
const restarted = (seconds: number) => `[test guard: child printed nothing for ${seconds} s; started again once]`;

test("a child that sleeps silently is started again once, then fails with both notes", async () => {
  const { starts, start } = counted("await Bun.sleep(60_000)");
  const result = await finished(start, 1_500);
  expect(starts.count).toBe(2);
  expect(result).toMatchObject({ stdout: "", killed: true, startedAgain: true });
  expect(result.stderr).toBe(`\n${restarted(1.5)}\n[test guard: killed after 1.5 s without exiting]`);
  expect(warned).toEqual([restarted(1.5)]);
}, 30_000);

test("a child that prints and then hangs is never started again", async () => {
  const { starts, start } = counted("console.log('working'); await Bun.sleep(60_000)");
  const result = await finished(start, 6_000, 3_000);
  expect(starts.count).toBe(1);
  expect(result).toMatchObject({ stdout: "working\n", killed: true, startedAgain: false });
  expect(result.stderr).toBe("\n[test guard: killed after 6 s without exiting]");
  expect(warned).toEqual([]);
}, 30_000);

test("a child that exits 1 without printing is never started again", async () => {
  const { starts, start } = counted("process.exit(1)");
  expect(await finished(start, 6_000, 3_000)).toEqual({ stdout: "", stderr: "", exit: 1, killed: false, startedAgain: false });
  expect(starts.count).toBe(1);
  expect(warned).toEqual([]);
}, 30_000);

test("a child silent on its first start and quick on the second passes with clean output, the note in the test output", async () => {
  const marker = path.join(root, "first-start");
  const { starts, start } = counted(`import { existsSync, writeFileSync } from "node:fs";
const marker = process.argv.at(-1);
if (existsSync(marker)) console.log("passed"); else { writeFileSync(marker, ""); await Bun.sleep(60_000); }`, marker);
  // The silent-start wait (1 s here, 45 s by default) ends well before the guard.
  expect(await finished(start, 30_000, 1_000)).toEqual({ stdout: "passed\n", stderr: "", exit: 0, killed: false, startedAgain: true });
  expect(starts.count).toBe(2);
  expect(warned).toEqual([restarted(1)]);
}, 30_000);

test("a silent child that prints only while being killed, and outlives SIGTERM, is still started again and then ended", async () => {
  // A CLI's SIGTERM handler may print as it closes; one stuck in a loop never exits on SIGTERM at all.
  const { starts, start } = counted("process.on('SIGTERM', () => console.error('closing')); await Bun.sleep(60_000)");
  const result = await finished(start, 1_500);
  expect(starts.count).toBe(2);
  expect(result).toMatchObject({ stdout: "", killed: true, startedAgain: true });
  expect(result.stderr).toEndWith(`\n${restarted(1.5)}\n[test guard: killed after 1.5 s without exiting]`);
}, 60_000);
