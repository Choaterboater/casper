// Re-copy GreenCLI's risky-lines checker into src/network/risky-lines.ts:
//   bun scripts/sync-risky-lines.ts            (GreenCLI next to Casper, or GREENCLI_DIR=…)
// tests/risky-lines-sync.test.ts fails when the copy and GreenCLI's origin/main differ.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

export const GREENCLI = process.env.GREENCLI_DIR ?? path.resolve(import.meta.dir, "../../GreenCli");
export const COPY = path.resolve(import.meta.dir, "../src/network/risky-lines.ts");
export const MARKER = "// ---- greencli source below ----\n";

export function greencliFile(file: string): string {
  return execFileSync("git", ["-C", GREENCLI, "show", `origin/main:${file}`], { encoding: "utf8" });
}

/** The Casper copy: the self-contained gate patterns from aiGating.ts, then riskyLines.ts without its import. */
export function forCasper(aiGating: string, riskyLines: string): string {
  const start = aiGating.indexOf("export const AI_READ_ONLY_CMD");
  const pipes = aiGating.indexOf("export const AUDITOR_PIPES");
  const end = aiGating.indexOf("]);\n", pipes);
  const importLine = /^import \{[^}]*\} from '\.\/aiGating';\n/m;
  if (start < 0 || pipes < 0 || end < 0 || !importLine.test(riskyLines)) throw new Error("GreenCLI's riskyLines/aiGating changed shape; update forCasper");
  return `${aiGating.slice(start, end + 4)}\n${riskyLines.replace(importLine, "")}`;
}

if (import.meta.main) {
  const sha = execFileSync("git", ["-C", GREENCLI, "rev-parse", "--short", "origin/main"], { encoding: "utf8" }).trim();
  writeFileSync(COPY, `// Copied from GreenCLI src/utils/riskyLines.ts (and the gate patterns of src/utils/aiGating.ts) @ ${sha}.\n`
    + "// Do not edit here: change it in GreenCLI, then run bun scripts/sync-risky-lines.ts.\n"
    + "/* eslint-disable */\n" + MARKER + forCasper(greencliFile("src/utils/aiGating.ts"), greencliFile("src/utils/riskyLines.ts")));
  console.log(`Copied GreenCLI @ ${sha} to src/network/risky-lines.ts`);
}
