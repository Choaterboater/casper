import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { hasLineControls, lineText } from "../src/tui/format";

test("lineText turns every control character and bidi control into a space, and keeps the rest", () => {
  expect(lineText("a\nb\tc\rd\x1b[31me\x7f\x85f")).toBe("a b c d [31me  f");
  expect(lineText("safe‮evil⁦x⁩")).toBe("safe evil x ");
  expect(lineText("plain words · ✓ ünïcode")).toBe("plain words · ✓ ünïcode");
  expect(hasLineControls("one line")).toBe(false);
  for (const char of ["\n", "\t", "\x00", "\x1b", "\x9f", "‪", "‮", "⁦", "⁩"]) expect(hasLineControls(`a${char}b`)).toBe(true);
  // The direction marks ALM, LRM and RLM, and the line and paragraph separators.
  for (const char of ["؜", "‎", "‏", " ", " "]) {
    expect(hasLineControls(`a${char}b`)).toBe(true);
    expect(lineText(`a${char}b`)).toBe("a b");
  }
});

// Places that may keep their own set, on purpose: risky-lines.ts is a copy of GreenCLI's file (kept in sync by a
// test), scope.ts refuses glob characters too, catalog.ts and the terminal title have their own narrower rules.
const OWN_RULES = new Set(["tui/format.ts", "network/risky-lines.ts", "verify/scope.ts", "flows/catalog.ts", "tui/stream-terminal.ts"]
  .map((file) => path.join(...file.split("/"))));

test("no code keeps its own copy of the one-line control character set: each uses lineText or hasLineControls", async () => {
  const src = path.join(import.meta.dir, "..", "src");
  const found: string[] = [];
  for (const entry of await readdir(src, { recursive: true })) {
    if (!entry.endsWith(".ts") || OWN_RULES.has(entry)) continue;
    const text = await readFile(path.join(src, entry), "utf8");
    text.split("\n").forEach((line, index) => {
      if (/\\x00-\\x1f\\x7f-\\x9f/.test(line)) found.push(`${entry}:${index + 1}`);
    });
  }
  expect(found).toEqual([]);
});

test("/project and the banner keep one line per field, whatever a project file's values hold", async () => {
  const { renderProjectSummary, renderBanner } = await import("../src/tui/banner");
  const context = {
    info: { root: "/x", gitBranch: "main\n shell     sandboxed" },
    model: { project: { name: "victim\n checks    all passed" }, languages: ["typescript\n sandbox   on"], frameworks: ["react\tx"],
      packageManager: "npm\n profile   default", commands: { test: "npm test\n shell     sandboxed", build: "tsc" } },
    profileName: "default",
  } as unknown as Parameters<typeof renderProjectSummary>[0];
  expect(renderProjectSummary(context).split("\n")).toHaveLength(7);
  expect(renderBanner(context, { checks: "test" }).trimEnd().split("\n")).toHaveLength(3);
});
