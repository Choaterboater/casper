import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isMap, parseDocument } from "yaml";

/** Where your own settings live. */
export const USER_CONFIG = "~/.casper/config.yaml";

/**
 * Set one value in <home>/.casper/config.yaml for the user, who picked it from a numbered choice (/settings,
 * /details). Comments, order and every other setting stay as they are; the file is replaced in one step and a new
 * one is readable only by you. A file that is a link, does not parse or is not a mapping is left alone.
 */
export async function editUserConfig(home: string, keys: readonly string[], value: unknown): Promise<void> {
  const folder = path.join(home, ".casper");
  const file = path.join(folder, "config.yaml");
  let before: string | undefined;
  let mode = 0o600;
  try {
    const info = await lstat(file);
    if (!info.isFile()) throw new Error(`${USER_CONFIG} is not a plain file (a link?); refusing to change it`);
    mode = info.mode & 0o777;
    before = await readFile(file, "utf8");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const document = parseDocument(before ?? "");
  if (document.errors.length) throw new Error(`${USER_CONFIG} does not parse (${document.errors[0]!.message.split("\n")[0]}); fix it first`);
  if (document.contents !== null && !isMap(document.contents)) throw new Error(`${USER_CONFIG} is not a mapping; refusing to change it`);
  for (let depth = 1; depth < keys.length; depth++) {
    const parent = document.getIn(keys.slice(0, depth));
    if (parent !== undefined && parent !== null && !isMap(parent)) throw new Error(`${keys.slice(0, depth).join(".")} in ${USER_CONFIG} is not a mapping; refusing to change it`);
  }
  document.setIn([...keys], document.createNode(value));
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const temporary = path.join(folder, `.config.yaml.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, document.toString(), { mode, flag: "wx" });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** The value set in your config.yaml at these keys, or undefined (a missing or unreadable file reads as unset). */
export async function userConfigValue(home: string, keys: readonly string[]): Promise<unknown> {
  try { return parseDocument(await readFile(path.join(home, ".casper", "config.yaml"), "utf8")).getIn([...keys]); }
  catch { return undefined; }
}
