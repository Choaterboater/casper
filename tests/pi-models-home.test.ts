import { afterEach, expect, spyOn, test } from "bun:test";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PiModels } from "../src/runtime/pi-models";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

test("model defaults live in the given home's .casper, never the real home's", async () => {
  const real = await mkdtemp(path.join(os.tmpdir(), "casper-real-home-")); dirs.push(real);
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-home-")); dirs.push(home);
  const homedir = spyOn(os, "homedir").mockReturnValue(real);
  try {
    const catalog = { getModels: () => [], getModel: () => undefined } as unknown as ModelRuntime;
    const models = new PiModels(catalog, path.join(home, ".casper", "agent"), home);
    expect(await models.setRole("fast")).toEqual({});
    expect(models.getRoles()).toEqual({});
    expect(existsSync(path.join(home, ".casper", "settings.json"))).toBe(true);
    expect(readdirSync(real)).toEqual([]);
  } finally { homedir.mockRestore(); }
});
