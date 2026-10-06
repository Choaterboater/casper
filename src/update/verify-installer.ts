import { createHash } from "node:crypto";
import { verifySshSignature } from "./signature";

/**
 * Before `casper update` runs a release's installer: SHA256SUMS must carry the release key's signature (once there is a
 * key), and the installer must match its line in that list and the digest GitHub publishes for the file. Returns the
 * one sentence that says why it is not run, or undefined when it may run.
 */
export interface InstallerCheck {
  version: string;
  /** install.sh or install.ps1. */
  script: string;
  installer: string;
  sums: string;
  /** SHA256SUMS.sig, or undefined when the release has none. */
  signature: string | undefined;
  /** The pinned release key; empty checks no signature. */
  releaseKey: string;
  /** GitHub's `sha256:<hex>` digest for the installer, when it gives one. */
  published: string | undefined;
}

export function checkInstaller(check: InstallerCheck): string | undefined {
  const { version, script } = check;
  if (check.releaseKey) {
    if (check.signature === undefined) return `Casper ${version} has no release signature (SHA256SUMS.sig), so its installer was not run.`;
    if (!verifySshSignature(check.sums, check.signature, check.releaseKey)) {
      return `The release signature on Casper ${version} doesn't match the Casper release key, so its installer was not run.`;
    }
  }
  const digest = createHash("sha256").update(check.installer).digest("hex");
  const listed = check.sums.split(/\r?\n/).map((line) => /^([0-9a-f]{64})\s+\*?(\S+)$/i.exec(line.trim())).find((match) => match?.[2] === script)?.[1];
  if (check.releaseKey && !listed) return `The signed list for Casper ${version} does not name ${script}, so it was not run.`;
  const published = check.published?.replace(/^sha256:/i, "");
  // Nothing to check it against: not run.
  if (!listed && !published) return `GitHub published no checksum for the Casper ${version} installer, so it was not run.`;
  if ((listed && listed.toLowerCase() !== digest) || (published && published.toLowerCase() !== digest)) {
    return "The downloaded installer did not match the release's checksum, so it was not run.";
  }
  return undefined;
}
