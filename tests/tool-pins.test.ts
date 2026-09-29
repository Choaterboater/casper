import { expect, test } from "bun:test";
import path from "node:path";
import { pinProblems } from "../scripts/check-tool-pins";
import { SECURITY_TOOLS } from "../src/security/tools";

/** The CI pin check: a fake release checksum file, so no download happens here. */

const tools = Object.values(SECURITY_TOOLS);
const sumsFrom = (change?: string) => async (url: string): Promise<string> => {
  const lines: string[] = [];
  for (const tool of tools) {
    if (tool.source.kind !== "binary") continue;
    for (const asset of Object.values(tool.source.assets)) {
      if (!url.startsWith(path.posix.dirname(asset.url))) continue;
      const file = path.posix.basename(asset.url);
      lines.push(`${file === change ? "0".repeat(64) : asset.sha256}  ${file}`);
    }
  }
  return `${lines.join("\n")}\n${"1".repeat(64)}  something_else.tar.gz\n`;
};

test("every binary pin matches its release's checksum file", async () => {
  expect(await pinProblems(tools, sumsFrom())).toEqual([]);
});

test("a pin that differs from the release is named, with both values", async () => {
  const problems = await pinProblems(tools, sumsFrom("osv-scanner_linux_amd64"));
  expect(problems).toHaveLength(1);
  expect(problems[0]).toStartWith("osv-scanner linux-x64: pinned ");
  expect(problems[0]).toContain(`the release says ${"0".repeat(64)}`);
});

test("a download missing from the checksum file, or a file that can't be fetched, is a problem", async () => {
  expect(await pinProblems(tools, async () => "")).toContain("gitleaks linux-x64: gitleaks_8.30.1_linux_x64.tar.gz is not in gitleaks_8.30.1_checksums.txt");
  const failed = await pinProblems(tools, async () => { throw new Error("HTTP 404"); });
  expect(failed).toContain("gitleaks: couldn't get gitleaks_8.30.1_checksums.txt: HTTP 404");
});
