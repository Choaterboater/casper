import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { lockedEntryPath } from "../../security/install";
import type { LockedSpec } from "../../security/tools";
import networkLock from "./casper-network-mcp.lock.txt" with { type: "text" };

/**
 * The network server Casper sets up for you: casper-network-mcp, pinned to one release and installed
 * from that release's hash lock (every package pinned by sha256) into ~/.casper/tools/casper-network-mcp.
 * That pin is the floor and the offline fallback: a newer release on GitHub is offered between Casper releases and
 * installed from the lock attached to it, checked first (releases.ts). Bumping the pin is a manual step:
 * `bun scripts/update-network-lock.ts <version>` rewrites the version below and the lock next to this file.
 */

/** The server's name in ~/.casper/mcp.json. */
export const NETWORK_SERVER_NAME = "network";

export const NETWORK_SERVER_VERSION = "0.1.3";

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

/** What you answered about setting it up, kept in ~/.casper/network-setup.json. */
export interface NetworkSetupState {
  /** "not-now": don't offer setup again; /mcp setup network still works. */
  answer?: "not-now";
  /** "Not now" to the update to this version (pinned or a release): not asked again for it. */
  updateNotNow?: string;
}

export const NETWORK_SETUP_FILE = path.join(".casper", "network-setup.json");

export async function readSetupState(homeDir: string): Promise<NetworkSetupState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(homeDir, NETWORK_SETUP_FILE), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown>;
    return {
      ...(record.answer === "not-now" ? { answer: "not-now" as const } : {}),
      ...(typeof record.updateNotNow === "string" && /^\d{1,6}(?:\.\d{1,6}){1,3}$/.test(record.updateNotNow) ? { updateNotNow: record.updateNotNow } : {}),
    };
  } catch {
    return {};
  }
}

/** Merges `change` into the file (0600), through a temporary file that replaces it. */
export async function writeSetupState(homeDir: string, change: NetworkSetupState): Promise<void> {
  const file = path.join(homeDir, NETWORK_SETUP_FILE);
  const next = { ...await readSetupState(homeDir), ...change };
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(next)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
