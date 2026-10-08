import { afterEach, expect, spyOn, test } from "bun:test";
import { SettingsManager, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PiModels, settingsLockBusy } from "../src/runtime/pi-models";
import { removeTempDir } from "./support/temp-dir";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => removeTempDir(dir))); });

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

/** Model defaults whose reads fail `failures` times with `error`, then read `content`. Counts every read. */
function stubbedDefaults(failures: number, error: () => unknown, content = JSON.stringify({ modelRoles: { fast: "fixture/fast" } })) {
  const reads = { count: 0 };
  const storage: Parameters<typeof SettingsManager.fromStorage>[0] = { withLock(scope, read) {
    if (scope !== "global") return;
    reads.count++;
    if (reads.count <= failures) throw error();
    read(content);
  } };
  const create = spyOn(SettingsManager, "create").mockImplementation(() => SettingsManager.fromStorage(storage, { projectTrusted: false }));
  return { reads, create };
}
const held = () => Object.assign(new Error("Lock file is already being held"), { code: "ELOCKED" });
const catalog = { getModels: () => [], getModel: () => undefined } as unknown as ModelRuntime;

test("model defaults another Casper has locked are read again once the lock is free", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-home-")); dirs.push(home);
  const { reads, create } = stubbedDefaults(2, held);
  try {
    expect(new PiModels(catalog, path.join(home, ".casper", "agent"), home).getRoles()).toEqual({ fast: "fixture/fast" });
    expect(reads.count).toBe(3);
  } finally { create.mockRestore(); }
});

test("model defaults that stay locked say another Casper is using them, not that the file is broken", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-home-")); dirs.push(home);
  const { reads, create } = stubbedDefaults(Infinity, held);
  try {
    const models = new PiModels(catalog, path.join(home, ".casper", "agent"), home);
    expect(() => models.getRoles()).toThrow("in use by another Casper; try again in a moment");
    expect(reads.count).toBeGreaterThan(1);
    expect(reads.count).toBeLessThan(10);
  } finally { create.mockRestore(); }
});

test("broken model defaults are not read again and still ask for a repair", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-home-")); dirs.push(home);
  const { reads, create } = stubbedDefaults(0, held, "{ not json");
  try {
    const models = new PiModels(catalog, path.join(home, ".casper", "agent"), home);
    expect(() => models.getRoles()).toThrow("repair the file before selecting a model");
    expect(reads.count).toBe(1);
  } finally { create.mockRestore(); }
});

test("only a lock another Casper holds or is dropping counts as busy model defaults", () => {
  const lock = path.join("home", ".casper", "settings.json.lock");
  const failure = (code: string, file: string) => Object.assign(new Error(`${code}: mkdir '${file}'`), { code, path: file, syscall: "mkdir" });
  expect(settingsLockBusy(held(), "linux")).toBe(true);
  // Windows fails to create a folder another process is still deleting with EPERM, EACCES or EBUSY.
  for (const code of ["EPERM", "EACCES", "EBUSY", "EEXIST"]) expect(settingsLockBusy(failure(code, lock), "win32")).toBe(true);
  expect(settingsLockBusy(failure("EPERM", lock), "linux")).toBe(false);
  expect(settingsLockBusy(failure("EPERM", path.join("home", ".casper", "settings.json")), "win32")).toBe(false);
  expect(settingsLockBusy(failure("ENOSPC", lock), "win32")).toBe(false);
  expect(settingsLockBusy(new SyntaxError("Unexpected token"), "win32")).toBe(false);
});
