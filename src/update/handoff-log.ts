import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { compareVersions } from "./command";

/**
 * The Windows update runs in a hidden process after Casper exits, so nobody sees what it does. It writes
 * ~/.casper/update.log instead: one file, overwritten by each update, with one line per step and a last line
 * `result: ok` or `result: failed: <why>`. Casper starts the file with `result: pending`. The next `casper update`,
 * `casper doctor` and session start read it and say plainly when the last update did not finish.
 * The file holds versions, process ids, the installer's SHA-256 and error text. No logins, no tokens.
 */

export const UPDATE_LOG = "update.log";
/** A log still `pending` after this long means the hidden helper never finished (it waits at most 5 minutes for Casper to exit). */
export const PENDING_TOO_LONG_MS = 15 * 60 * 1000;
const INSTALL_ONE_LINER = "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; irm https://github.com/Choaterboater/casper/releases/download";

export function updateLogPath(stateDir: string): string {
  return path.join(stateDir, UPDATE_LOG);
}

/** Starts a fresh log (the helper appends to it). Returns its path, or undefined when it could not be written. */
export async function startUpdateLog(stateDir: string, from: string, to: string): Promise<string | undefined> {
  const file = updateLogPath(stateDir);
  try {
    await mkdir(stateDir, { recursive: true });
    await writeFile(file, [`casper update ${from} -> ${to}`, `target: ${to}`, `started: ${new Date().toISOString()}`, "result: pending", ""].join("\n"), { mode: 0o600 });
    return file;
  } catch { return undefined; }
}

export async function removeUpdateLog(stateDir: string): Promise<void> {
  await rm(updateLogPath(stateDir), { force: true }).catch(() => undefined);
}

export interface UpdateFailure { version: string; reason: string; file: string }

/** What the log says about the last update, when it did not finish and the version it was for is still newer than this one. */
export async function lastUpdateFailure(stateDir: string, currentVersion: string, now: number = Date.now()): Promise<UpdateFailure | undefined> {
  const file = updateLogPath(stateDir);
  try {
    const [text, info] = await Promise.all([readFile(file, "utf8"), stat(file)]);
    const lines = text.split(/\r?\n/).map((line) => line.replace(/^﻿/, "").replace(/^\d{4}-\d\d-\d\dT[\d:]+ /, "").trim());
    const version = lines.find((line) => line.startsWith("target: "))?.slice("target: ".length).trim();
    if (!version || compareVersions(version, currentVersion) <= 0) return undefined;
    const last = [...lines].reverse().find((line) => line.startsWith("result: "));
    if (!last) return undefined;
    const result = last.slice("result: ".length);
    if (result === "ok") return undefined;
    if (result === "pending") return now - info.mtimeMs > PENDING_TOO_LONG_MS ? { version, reason: "the helper that installs it never finished", file } : undefined;
    return { version, reason: result.replace(/^failed:\s*/, "") || "it did not finish", file };
  } catch { return undefined; }
}

/** The plain words for a failed update, with where to look and the one-line install that works. */
export function updateFailureLines(failure: UpdateFailure, shownFile: string = failure.file): string[] {
  return [
    `The last update to Casper ${failure.version} did not finish: ${failure.reason}.`,
    `What it did is in ${shownFile}. To install it now, run this in PowerShell: ${INSTALL_ONE_LINER}/v${failure.version}/install.ps1 | iex`,
  ];
}
