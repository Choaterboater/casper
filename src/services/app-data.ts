/** Files a running app writes as it works (its data store, logs), not code or configuration it loads.
 * Manifests, lockfiles and tool configs are inputs even though they are JSON. */
export function appDataFile(file: string): boolean {
  const name = file.replace(/\\/g, "/").split("/").pop()!.toLowerCase();
  if (/^(?:package|package-lock|composer|deno|bun|tsconfig.*|jsconfig.*|.*\.config|\..*rc|manifest|app|appsettings.*)\.jsonc?$/.test(name)) return false;
  return /\.(?:json|jsonl|ndjson|csv|log|db|sqlite3?|db-(?:wal|shm|journal)|sqlite3?-(?:wal|shm|journal))$/.test(name);
}
