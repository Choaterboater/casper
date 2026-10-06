import { expect, test } from "bun:test";
import type { Stats } from "node:fs";
import path from "node:path";
import { canonicalStatePath } from "../src/runtime/pi";

const missing = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });
const entry = (link: boolean) => ({ isSymbolicLink: () => link }) as Stats;
// The path as this system writes it (a drive and backslashes on Windows).
const FILE = path.resolve("/home/agent/auth.json");

test("a state file another Casper creates mid-check resolves; it is not taken for a dangling link", async () => {
  // Two `casper learn` runs share one home: the other run writes auth.json between this run's realpath and lstat.
  let created = false;
  const fs = {
    realpath: async (file: string) => { if (file === FILE && !created) throw missing(); return file; },
    lstat: async (_file: string) => { created = true; return entry(false); },
  };
  expect(await canonicalStatePath(FILE, new AbortController().signal, fs)).toBe(FILE);
});

test("a dangling state link is still refused", async () => {
  const fs = {
    realpath: async (file: string) => { if (file === FILE) throw missing(); return file; },
    lstat: async (_file: string) => entry(true),
  };
  await expect(canonicalStatePath(FILE, new AbortController().signal, fs)).rejects.toThrow("Cannot resolve writable runtime state");
});

test("a missing state file resolves under its existing parent", async () => {
  const fs = {
    realpath: async (file: string) => { if (file.endsWith(".json")) throw missing(); return `/real${file}`; },
    lstat: async (_file: string) => { throw missing(); },
  };
  expect(await canonicalStatePath(FILE, new AbortController().signal, fs)).toBe(path.join(`/real${path.dirname(FILE)}`, "auth.json"));
});
