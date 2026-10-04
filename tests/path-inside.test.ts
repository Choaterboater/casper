import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { riskyLinesIn } from "../src/network/risky-receipt";
import { isOutside } from "../src/platform/inside";
import { within } from "../src/platform/project-paths";
import { relativePath } from "../src/security/parse";

describe("inside the project", () => {
  test("only a real step up counts as outside", () => {
    expect(isOutside("..")).toBe(true);
    expect(isOutside("../x")).toBe(true);
    expect(isOutside("..\\x")).toBe(true);
    expect(isOutside(path.resolve("/elsewhere"))).toBe(true);
    expect(isOutside("..env")).toBe(false);
    expect(isOutside("..hidden/file")).toBe(false);
    expect(isOutside("src/a.ts")).toBe(false);
    expect(isOutside("")).toBe(false);
  });

  test("a file named ..env is inside the project", () => {
    const root = path.resolve("/project");
    expect(within(root, path.join(root, "..env"))).toBe(true);
    expect(within(root, path.join(root, "..config", "a"))).toBe(true);
    expect(within(root, path.resolve(root, "..", "other"))).toBe(false);
    expect(relativePath(root, "..env")).toBe("..env");
    expect(relativePath(root, "../other/x.txt")).toBe("x.txt");
  });

  test("a changed config file named ..switch.cfg still shows its risky lines", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "casper-inside-"));
    try {
      await writeFile(path.join(root, "..switch.cfg"), "hostname sw1\nreload\n");
      expect(await riskyLinesIn(root, ["..switch.cfg"])).toEqual([{ file: "..switch.cfg", line: 2, text: "reload", reason: "reboots the switch" }]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("no code tests for a step out by hand: each uses the one shared check", async () => {
    const src = path.join(import.meta.dir, "..", "src");
    const found: string[] = [];
    for (const entry of await readdir(src, { recursive: true })) {
      if (!entry.endsWith(".ts") || entry === path.join("platform", "inside.ts")) continue;
      const text = await readFile(path.join(src, entry), "utf8");
      text.split("\n").forEach((line, index) => {
        if (/startsWith\((?:"\.\.|'\.\.|`\.\.)/.test(line)) found.push(`${entry}:${index + 1}`);
      });
    }
    expect(found).toEqual([]);
  });
});
