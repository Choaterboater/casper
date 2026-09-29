/**
 * Checks the sha256 pins of the security tools Casper downloads (src/security/tools.ts) against the
 * checksum file each project publishes with its release. Run in CI by .github/workflows/live-checks.yml,
 * never in the normal test suite (it downloads). Exit 0 when every pin matches, 1 otherwise.
 *
 *   bun run scripts/check-tool-pins.ts
 */
import path from "node:path";
import { SECURITY_TOOLS, type SecurityToolSpec } from "../src/security/tools";

/** The checksum file each binary tool publishes next to its downloads. */
export const CHECKSUM_FILES: Record<string, (version: string) => string> = {
  gitleaks: (version) => `gitleaks_${version}_checksums.txt`,
  "osv-scanner": () => "osv-scanner_SHA256SUMS",
};

/** "<sha256>  <file>" lines → file → sha256. */
export function parseChecksums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(\S+)$/i.exec(line.trim());
    if (match) sums.set(match[2]!, match[1]!.toLowerCase());
  }
  return sums;
}

/** Every pin that does not match its release's checksum file, in plain lines; empty when all match. */
export async function pinProblems(tools: readonly SecurityToolSpec[], fetchText: (url: string) => Promise<string>): Promise<string[]> {
  const problems: string[] = [];
  for (const tool of tools) {
    if (tool.source.kind !== "binary") continue;
    const fileName = CHECKSUM_FILES[tool.id];
    if (!fileName) { problems.push(`${tool.id}: Casper doesn't know its checksum file`); continue; }
    const assets = Object.entries(tool.source.assets);
    const base = path.posix.dirname(assets[0]![1].url);
    let sums: Map<string, string>;
    try { sums = parseChecksums(await fetchText(`${base}/${fileName(tool.version)}`)); }
    catch (error) { problems.push(`${tool.id}: couldn't get ${fileName(tool.version)}: ${(error as Error).message}`); continue; }
    for (const [platform, asset] of assets) {
      if (path.posix.dirname(asset.url) !== base) { problems.push(`${tool.id} ${platform}: not from the same release as the others`); continue; }
      const file = path.posix.basename(asset.url);
      const expected = sums.get(file);
      if (!expected) problems.push(`${tool.id} ${platform}: ${file} is not in ${fileName(tool.version)}`);
      else if (expected !== asset.sha256.toLowerCase()) problems.push(`${tool.id} ${platform}: pinned ${asset.sha256}, the release says ${expected}`);
    }
  }
  return problems;
}

if (import.meta.main) {
  const problems = await pinProblems(Object.values(SECURITY_TOOLS), async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  });
  if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
  console.log("Every security tool pin matches its release's checksum file.");
}
