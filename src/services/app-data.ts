/** Files a running app writes as it works (its data store, logs), not code or configuration it loads.
 * Manifests, lockfiles and tool configs are inputs even though they are JSON. */
export function appDataFile(file: string): boolean {
  const name = file.replace(/\\/g, "/").split("/").pop()!.toLowerCase();
  if (/^(?:package|package-lock|composer|deno|bun|tsconfig.*|jsconfig.*|.*\.config|\..*rc|manifest|app|appsettings.*)\.jsonc?$/.test(name)) return false;
  return /\.(?:json|jsonl|ndjson|csv|log|db|sqlite3?|db-(?:wal|shm|journal)|sqlite3?-(?:wal|shm|journal))$/.test(name);
}

/** Settings an app may write as it runs (an installed widget in config/widgets.yaml): YAML, TOML and INI files, not
 * lockfiles. Kept apart from the data files so a project with many of them still has its data snapshot. */
export function settingsFile(file: string): boolean {
  const name = file.replace(/\\/g, "/").split("/").pop()!.toLowerCase();
  return /\.(?:ya?ml|toml|ini)$/.test(name) && !/^(?:pnpm-lock\.yaml|poetry\.lock|cargo\.lock)$/.test(name) && !name.endsWith(".lock.yaml");
}
