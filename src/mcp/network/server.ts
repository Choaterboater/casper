import { lockedEntryPath } from "../../security/install";
import type { LockedSpec } from "../../security/tools";
import networkLock from "./casper-network-mcp.lock.txt" with { type: "text" };

/**
 * The network server Casper sets up for you: casper-network-mcp, pinned to one release and installed
 * from that release's hash lock (every package pinned by sha256) into ~/.casper/tools/casper-network-mcp.
 * Bumping it is a manual step: `bun scripts/update-network-lock.ts <version>` rewrites the version below
 * and the lock next to this file.
 */

/** The server's name in ~/.casper/mcp.json. */
export const NETWORK_SERVER_NAME = "network";

export const NETWORK_SERVER_VERSION = "0.1.0";

export const NETWORK_SERVER: LockedSpec = {
  id: "casper-network-mcp",
  label: "casper-network-mcp",
  version: NETWORK_SERVER_VERSION,
  source: { kind: "uv-lock", package: "casper-network-mcp", lock: networkLock, lockName: "casper-network-mcp.lock.txt", python: ">=3.12", entry: "casper-network-mcp" },
  // The installed venv for 0.1.0 is about 60 MB on disk.
  approxMB: 60,
  hosts: ["pypi.org", "files.pythonhosted.org"],
};

/** The entry written to ~/.casper/mcp.json: the installed program by its absolute path, never a package runner. */
export function networkServerEntry(homeDir: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[]; env: Record<string, string> } {
  return { command: lockedEntryPath(homeDir, NETWORK_SERVER, platform), args: [], env: {} };
}
