/**
 * /lab import <file>: add devices to your lab list (lab.hosts in ~/.casper/config.yaml) from a file, for example
 * GreenCLI's export of its lab-tagged hosts. The list only marks devices as lab (any device may be checked, after
 * your answer); only your own command and a numbered "2 Add them" write it.
 */
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isMap, isSeq, parseDocument } from "yaml";
import { terminalText } from "../tui/format";
import { parseLabSettings } from "./spec";

/** The hosts in a lab file: JSON `{"hosts": [...]}`, or one host per line (`#` comments). Each is checked like lab.hosts. */
export function parseLabFile(text: string): string[] {
  const trimmed = text.trim();
  let hosts: unknown;
  if (trimmed.startsWith("{")) {
    let document: unknown;
    try { document = JSON.parse(trimmed); } catch { throw new Error("the file is not valid JSON"); }
    hosts = typeof document === "object" && document !== null ? (document as { hosts?: unknown }).hosts : undefined;
    if (!Array.isArray(hosts)) throw new Error('expected {"hosts": [...]}: a list of hostnames, IP addresses or ranges');
  } else {
    hosts = trimmed.split(/\r?\n/).map((line) => line.replace(/#.*$/, "").trim()).filter(Boolean);
  }
  const parsed = parseLabSettings({ hosts }, "user", "the file");
  if (!parsed || !parsed.hosts.length) throw new Error("the file lists no hosts");
  return parsed.hosts;
}

/** Where /lab import writes: your config.yaml, or the profile's when the profile has its own lab list (it wins). */
export function labConfigPlace(profile?: string): string {
  return profile ? `~/.casper/profiles/${profile}/config.yaml` : "~/.casper/config.yaml";
}

/** Add hosts to lab.hosts in <home>/.casper/config.yaml (or the profile's), keeping everything else and its comments. */
export async function addLabHosts(home: string, hosts: readonly string[], profile?: string): Promise<{ file: string; added: string[]; already: string[] }> {
  const folder = profile ? path.join(home, ".casper", "profiles", profile) : path.join(home, ".casper");
  const file = path.join(folder, "config.yaml");
  let before: string | undefined;
  let mode = 0o600;
  try {
    const info = await lstat(file);
    if (!info.isFile()) throw new Error(`${labConfigPlace(profile)} is not a plain file (a link?); refusing to change it. Add the hosts there yourself`);
    mode = info.mode & 0o777;
    before = await readFile(file, "utf8");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const document = parseDocument(before ?? "");
  if (document.errors.length) throw new Error(`${labConfigPlace(profile)} does not parse (${document.errors[0]!.message.split("\n")[0]}); fix it first`);
  if (document.contents !== null && !isMap(document.contents)) throw new Error(`${labConfigPlace(profile)} is not a mapping; refusing to change it`);
  const lab = document.get("lab");
  if (lab !== undefined && lab !== null && !isMap(lab)) throw new Error(`lab in ${labConfigPlace(profile)} is not a mapping; refusing to change it`);
  const list = document.getIn(["lab", "hosts"]);
  if (list !== undefined && list !== null && !isSeq(list)) throw new Error(`lab.hosts in ${labConfigPlace(profile)} is not a list; refusing to change it`);
  const existing = new Set(isSeq(list) ? list.items.map((item) => String((item as { value?: unknown }).value ?? item).toLowerCase()) : []);
  const added = hosts.filter((host) => !existing.has(host.toLowerCase()));
  const already = hosts.filter((host) => existing.has(host.toLowerCase()));
  if (!added.length) return { file, added, already };
  if (isSeq(list)) for (const host of added) list.add(document.createNode(host));
  else document.setIn(["lab", "hosts"], document.createNode([...added]));
  // What is written must still read back as a valid lab list.
  parseLabSettings((document.toJSON() as { lab?: unknown } | null)?.lab, "user");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const temporary = path.join(folder, `.config.yaml.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, document.toString(), { mode, flag: "wx" });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return { file, added, already };
}

/** The entries for the import box: every address range in full (one can mark many devices lab, so none is ever
 * hidden), then up to 20 plain names, with a count of the rest. */
export function labImportList(entries: readonly string[]): string {
  const ranges = entries.filter((entry) => entry.includes("/"));
  const names = entries.filter((entry) => !entry.includes("/"));
  return [...ranges, ...names.slice(0, 20)].map(terminalText).join(", ") + (names.length > 20 ? ` and ${names.length - 20} more` : "");
}
