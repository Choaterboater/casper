import { lstat } from "node:fs/promises";
import path from "node:path";
import { isModelProviderKeyName } from "../platform/environment";
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
      // "fixture/demo · effort auto": the model and its effort, nothing more (the banner adds when it starts).
      const effort = Array.isArray(value.autoEffortModels) && value.autoEffortModels.includes(identity)
        ? "auto" : typeof value.defaultThinkingLevel === "string" ? value.defaultThinkingLevel : undefined;
      return effort ? `${identity} · effort ${effort}` : identity;
    } finally { await file.close(); }
  } catch { return undefined; }
}

/** Whether any sign-in exists: a provider in Casper's saved sign-ins, or a provider key in the environment.
 * Advisory (the banner and footer only): it reads which providers are there, never a key. */
export async function hasSignIn(agentDir: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  // Only the variables Pi reads a provider key from: an unrelated STRIPE_API_KEY is not a sign-in.
  if (Object.entries(env).some(([name, value]) => value && isModelProviderKeyName(name))) return true;
  try {
    const file = await openNoFollow(path.join(agentDir, "auth.json"));
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 1024 * 1024) return stat.isFile();
      const value: unknown = JSON.parse((await file.readFile("utf8")) || "{}");
      return Boolean(value && typeof value === "object" && Object.keys(value).length);
    } finally { await file.close(); }
  } catch { return false; }
}
