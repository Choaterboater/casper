import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { COPY, forCasper, GREENCLI, greencliFile, MARKER } from "../scripts/sync-risky-lines";

// src/network/risky-lines.ts is GreenCLI's checker. Skipped when GreenCLI isn't next to Casper (CI).
describe.skipIf(!existsSync(path.join(GREENCLI, ".git")))("risky lines: Casper's copy matches GreenCLI", () => {
  test("the copy is GreenCLI's code (bun scripts/sync-risky-lines.ts re-copies it)", () => {
    const copy = readFileSync(COPY, "utf8");
    expect(copy.slice(copy.indexOf(MARKER) + MARKER.length)).toBe(forCasper(greencliFile("src/utils/aiGating.ts"), greencliFile("src/utils/riskyLines.ts")));
  });
});
