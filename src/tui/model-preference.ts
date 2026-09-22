import { lstat } from "node:fs/promises";
import path from "node:path";
import { openNoFollow } from "../platform/files";

/** Advisory startup display only. Activation/validation remains owned by PiModels.
 * Never read auth, start a runtime, repair settings or follow a settings alias. */
export async function modelPreference(home: string): Promise<string | undefined> {
  try {
    const directory = path.join(home, ".casper");
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    const file = await openNoFollow(path.join(directory, "settings.json"));
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024) return;
      const buffer = Buffer.alloc(16 * 1024 + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 16 * 1024) return;
      const value = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
      if (typeof value?.defaultProvider !== "string" || typeof value?.defaultModel !== "string") return;
      const identity = `${value.defaultProvider}/${value.defaultModel}`;
      const effort = Array.isArray(value.autoEffortModels) && value.autoEffortModels.includes(identity)
        ? "auto (pending)" : typeof value.defaultThinkingLevel === "string" ? value.defaultThinkingLevel : "effort default";
      return `default ${identity} · ${effort}`;
    } finally { await file.close(); }
  } catch { return undefined; }
}
