/** The first gh that can verify Casper's build provenance (older ones have no `attestation` command,
 * or cannot read the trusted root Casper's attestations use). */
export const GH_MIN_ATTEST = [2, 56, 0] as const;

/** major.minor.patch from `gh --version` output such as "gh version 2.55.0 (2026-01-01)", or undefined when unreadable. */
export function parseGhVersion(output: string): [number, number, number] | undefined {
  const match = /^gh version (\d{1,6})\.(\d{1,6})\.(\d{1,6})(?=\s|$)/m.exec(output);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/** True only when the output names a gh version of 2.56.0 or newer. Anything unreadable is false. */
export function ghCanVerifyBuild(output: string): boolean {
  const version = parseGhVersion(output);
  if (!version) return false;
  for (let i = 0; i < 3; i++) {
    if (version[i]! !== GH_MIN_ATTEST[i]) return version[i]! > GH_MIN_ATTEST[i]!;
  }
  return true;
}
