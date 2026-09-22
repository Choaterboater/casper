import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { autoEffortLevel, readAutoEffort, writeAutoEffort } from "../src/tui/auto-effort";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

test("auto effort maps intent to the lightest supported level at or above its target", () => {
  const all = ["off", "minimal", "low", "medium", "high", "xhigh"];
  expect(autoEffortLevel("fix", all)).toBe("high");
  expect(autoEffortLevel("implement", all)).toBe("high");
  expect(autoEffortLevel("test", all)).toBe("medium");
  expect(autoEffortLevel("inspect", all)).toBe("low");
  expect(autoEffortLevel("general", all)).toBe("low");
  // A model without "low" rounds up; one that tops out below the target takes its heaviest level.
  expect(autoEffortLevel("general", ["off", "medium", "high"])).toBe("medium");
  expect(autoEffortLevel("fix", ["off", "low"])).toBe("low");
  expect(autoEffortLevel("fix", [])).toBeUndefined();
});

test("the remembered auto choice round-trips beside Casper settings and clears on an explicit level", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-auto-effort-")); roots.push(home);
  expect(await readAutoEffort(home)).toBe(false);
  await writeAutoEffort(home, true);
  expect(await readAutoEffort(home)).toBe(true);
  await writeAutoEffort(home, false);
  expect(await readAutoEffort(home)).toBe(false);
  // Hand-edited or foreign content is not auto.
  await mkdir(path.join(home, ".casper"), { recursive: true });
  await writeFile(path.join(home, ".casper/effort.json"), "{\"mode\":\"high\"");
  expect(await readAutoEffort(home)).toBe(false);
});
