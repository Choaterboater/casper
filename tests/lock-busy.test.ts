import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { lockBusy } from "../src/platform/files";
import { ProjectMemory } from "../src/memory/store";
import { removeTempDir } from "./support/temp-dir";

const err = (code: string) => Object.assign(new Error(code), { code });

test("lockBusy: EEXIST means busy on every platform", () => {
  for (const platform of ["win32", "linux", "darwin"] as const) expect(lockBusy(err("EEXIST"), platform)).toBe(true);
});

test("lockBusy: EPERM, EACCES and EBUSY mean busy only on Windows", () => {
  for (const code of ["EPERM", "EACCES", "EBUSY"]) {
    expect(lockBusy(err(code), "win32")).toBe(true);
    expect(lockBusy(err(code), "linux")).toBe(false);
    expect(lockBusy(err(code), "darwin")).toBe(false);
  }
});

test("lockBusy: other errors are never busy", () => {
  for (const platform of ["win32", "linux"] as const) {
    expect(lockBusy(err("ENOENT"), platform)).toBe(false);
    expect(lockBusy(new Error("no code"), platform)).toBe(false);
    expect(lockBusy("nope", platform)).toBe(false);
  }
});

test("memory: 20 parallel updates to one file all land", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-lock-"));
  try {
    const store = new ProjectMemory(path.join(root, "state"));
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.remember(`fact number ${i}`)));
    expect((await store.facts()).map((f) => f.text).sort()).toEqual(Array.from({ length: 20 }, (_, i) => `fact number ${i}`).sort());
  } finally { await removeTempDir(root); }
});
