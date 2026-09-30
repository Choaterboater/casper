import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FADE_DAYS, SuggestionState } from "../src/flows/state";
import { needsPosixModes } from "./support/platform";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "casper-suggestions-"));
  temporary.push(base);
  const homeDir = path.join(base, "home");
  const root = path.join(base, "project");
  await mkdir(homeDir);
  await mkdir(root);
  let now = Date.parse("2026-09-01T00:00:00Z");
  return { homeDir, root, clock: { now: () => now, advance: (ms: number) => { now += ms; } } };
}

const DAY = 24 * 60 * 60 * 1000;

describe("suggestion state", () => {
  test("three ignores in a row hide a suggestion for 14 days in this project, then it comes back", async () => {
    const { homeDir, root, clock } = await fixture();
    const state = await SuggestionState.load({ root, homeDir, now: clock.now });
    await state.recordIgnored(["prove-fix"]);
    await state.recordIgnored(["prove-fix"]);
    expect(state.status("prove-fix")).toBe("on");
    await state.recordIgnored(["prove-fix"]);
    expect(state.status("prove-fix")).toBe("faded");
    expect(state.hiddenUntil("prove-fix")?.toISOString()).toBe("2026-09-15T00:00:00.000Z");
    // Remembered across restarts.
    const again = await SuggestionState.load({ root, homeDir, now: clock.now });
    expect(again.visible("prove-fix")).toBe(false);
    expect(again.visible("remember-test")).toBe(true);
    clock.advance(FADE_DAYS * DAY + 1);
    expect(again.status("prove-fix")).toBe("on");
  });

  test("choosing a suggestion resets its count", async () => {
    const { homeDir, root, clock } = await fixture();
    const state = await SuggestionState.load({ root, homeDir, now: clock.now });
    await state.recordIgnored(["prove-fix"]);
    await state.recordIgnored(["prove-fix"]);
    await state.recordChosen("prove-fix");
    await state.recordIgnored(["prove-fix"]);
    await state.recordIgnored(["prove-fix"]);
    expect(state.status("prove-fix")).toBe("on");
  });

  test("fading is per project", async () => {
    const { homeDir, root, clock } = await fixture();
    const other = path.join(path.dirname(root), "other");
    await mkdir(other);
    const state = await SuggestionState.load({ root, homeDir, now: clock.now });
    for (let i = 0; i < 3; i++) await state.recordIgnored(["prove-fix"]);
    expect((await SuggestionState.load({ root: other, homeDir, now: clock.now })).status("prove-fix")).toBe("on");
  });

  test("off per suggestion and off for all apply in every project; the config setting cannot be turned on here", async () => {
    const { homeDir, root, clock } = await fixture();
    const state = await SuggestionState.load({ root, homeDir, now: clock.now });
    await state.setOff(true, "remember-test");
    expect(state.status("remember-test")).toBe("off");
    expect(state.status("prove-fix")).toBe("on");
    await state.setOff(true);
    expect(state.status("prove-fix")).toBe("off");
    const other = path.join(path.dirname(root), "elsewhere");
    await mkdir(other);
    expect((await SuggestionState.load({ root: other, homeDir, now: clock.now })).allOff).toBe(true);
    await state.setOff(false);
    expect(state.status("remember-test")).toBe("on");
    const configured = await SuggestionState.load({ root, homeDir, now: clock.now, configOff: true });
    await configured.setOff(false);
    expect(configured.status("prove-fix")).toBe("off");
    expect(configured.offByConfig).toBe(true);
  });

  test("turning a faded suggestion back on shows it again", async () => {
    const { homeDir, root, clock } = await fixture();
    const state = await SuggestionState.load({ root, homeDir, now: clock.now });
    for (let i = 0; i < 3; i++) await state.recordIgnored(["prove-fix"]);
    await state.setOff(false, "prove-fix");
    expect(state.status("prove-fix")).toBe("on");
  });

  test("the key hint shows the first three times", async () => {
    const { homeDir, root, clock } = await fixture();
    const state = await SuggestionState.load({ root, homeDir, now: clock.now });
    for (let i = 0; i < 3; i++) {
      expect(state.hintDue).toBe(true);
      await state.recordShown(["prove-fix"], true);
    }
    expect(state.hintDue).toBe(false);
  });

  test("a corrupt file is started again with one notice and rewritten whole", async () => {
    const { homeDir, root, clock } = await fixture();
    const first = await SuggestionState.load({ root, homeDir, now: clock.now });
    await mkdir(path.dirname(first.projectFile), { recursive: true });
    await writeFile(first.projectFile, "{ not json");
    await writeFile(first.userFile, JSON.stringify({ version: 1, off: "yes", offIds: [] }));
    const state = await SuggestionState.load({ root, homeDir, now: clock.now });
    expect(state.notices).toEqual([
      `[suggestions] state reset (${state.projectFile} could not be read)`,
      `[suggestions] state reset (${state.userFile} could not be read)`,
    ]);
    expect(state.status("prove-fix")).toBe("on");
    expect(JSON.parse(await readFile(state.projectFile, "utf8"))).toEqual({ version: 1, rules: {}, hintsShown: 0 });
    expect(JSON.parse(await readFile(state.userFile, "utf8"))).toEqual({ version: 1, off: false, offIds: [] });
    // No temporary files are left behind.
    expect((await readdir(path.dirname(state.projectFile))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect((await SuggestionState.load({ root, homeDir, now: clock.now })).notices).toEqual([]);
  });

  needsPosixModes("state files are owner-only", async () => {
    const { homeDir, root, clock } = await fixture();
    const state = await SuggestionState.load({ root, homeDir, now: clock.now });
    await state.recordShown(["prove-fix"]);
    await state.setOff(true, "prove-fix");
    expect((await stat(state.projectFile)).mode & 0o777).toBe(0o600);
    expect((await stat(state.userFile)).mode & 0o777).toBe(0o600);
  });

  test("ids are checked", async () => {
    const { homeDir, root, clock } = await fixture();
    const state = await SuggestionState.load({ root, homeDir, now: clock.now });
    await expect(state.recordIgnored(["../x"])).rejects.toThrow("invalid suggestion id");
    await expect(state.setOff(true, "Bad")).rejects.toThrow("invalid suggestion id");
  });
});
