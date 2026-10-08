/**
 * Checks the sha256 pins of the programs Casper downloads (src/security/tools.ts and ripgrep-pin.ts) against the
 * checksum file each project publishes with its release. Run in CI by .github/workflows/live-checks.yml,
 * never in the normal test suite (it downloads). Exit 0 when every pin matches, 1 otherwise.
 *
 *   bun run scripts/check-tool-pins.ts
 */
import path from "node:path";
import { RIPGREP } from "../src/security/ripgrep-pin";
import { SECURITY_TOOLS, type PinnedSpec, type SecurityToolSpec } from "../src/security/tools";

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

/** The first 64-hex digest in a sidecar file: "<sha256>  <file>" (Linux and macOS) or CertUtil's output (Windows zips). */
export function sidecarDigest(text: string): string | undefined {
  return /\b([0-9a-f]{64})\b/i.exec(text)?.[1]?.toLowerCase();
}

/** Pins of a tool that publishes one `<download>.sha256` file per download (ripgrep): every one that differs. */
export async function sidecarProblems(tool: PinnedSpec, fetchText: (url: string) => Promise<string>): Promise<string[]> {
  const problems: string[] = [];
  if (tool.source.kind !== "binary") return problems;
  for (const [platform, asset] of Object.entries(tool.source.assets)) {
    let expected: string | undefined;
    try { expected = sidecarDigest(await fetchText(`${asset.url}.sha256`)); }
    catch (error) { problems.push(`${tool.id} ${platform}: couldn't get ${path.posix.basename(asset.url)}.sha256: ${(error as Error).message}`); continue; }
    if (!expected) problems.push(`${tool.id} ${platform}: ${path.posix.basename(asset.url)}.sha256 holds no digest`);
    else if (expected !== asset.sha256.toLowerCase()) problems.push(`${tool.id} ${platform}: pinned ${asset.sha256}, the release says ${expected}`);
  }
  return problems;
}

if (import.meta.main) {
  const fetchText = async (url: string) => {
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  };
  const problems = [...await pinProblems(Object.values(SECURITY_TOOLS), fetchText), ...await sidecarProblems(RIPGREP, fetchText)];
  if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
  console.log("Every security tool pin and the ripgrep pin match its release's checksum file.");
}
