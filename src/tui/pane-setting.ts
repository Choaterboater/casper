import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** The steps pane beside Casper inside tmux or iTerm2: on (the default inside tmux) or off. /pane on|off saves it. */
export type PaneSetting = "on" | "off";

const file = (home: string) => path.join(home, ".casper", "pane.json");

/** The saved setting, or undefined when nothing was saved (or the file is not Casper's). */
export async function readPaneSetting(home: string): Promise<PaneSetting | undefined> {
  try {
    const info = await lstat(file(home));
    if (!info.isFile() || info.size > 4096) return undefined;
    const value = JSON.parse(await readFile(file(home), "utf8")) as { version?: unknown; pane?: unknown };
    return value?.version === 1 && (value.pane === "on" || value.pane === "off") ? value.pane : undefined;
  } catch { return undefined; }
}

/** Save it in ~/.casper/pane.json (owner only; temporary file, then rename). */
export async function savePaneSetting(home: string, pane: PaneSetting): Promise<void> {
  const target = file(home);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ version: 1, pane })}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
