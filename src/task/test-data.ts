/**
 * Data a task's own runs left in the folder: a database its server made while the AI tried it, with the accounts and
 * sessions it signed up (src/task/attribution.ts, testDataFile). Shipped, the first person to register on a fresh install
 * was not the first user. Before the task ends the AI is told what is in it once; a file still there is named on the
 * receipt. A data file that was there before the task (a real app's live database) is never one of these.
 */
import { lstat } from "node:fs/promises";
import path from "node:path";

export interface TestData {
  /** The data file, with its -wal, -shm or -journal files folded in. */
  file: string;
  rows?: number;
  tables?: number;
}

const COMPANION = /-(?:wal|shm|journal)$/i;

/** What each file still there holds: a SQLite database's rows and tables (read only, never written), else nothing said. */
export async function describeTestData(root: string, files: readonly string[]): Promise<TestData[]> {
  const main = [...new Set(files.map((file) => file.replace(COMPANION, "")))].sort();
  const found: TestData[] = [];
  for (const file of main) {
    const absolute = path.join(root, ...file.split("/"));
    if (!(await lstat(absolute).catch(() => undefined))?.isFile()) continue;
    found.push({ file, ...await sqliteCounts(absolute) });
  }
  return found;
}

async function sqliteCounts(absolute: string): Promise<Pick<TestData, "rows" | "tables">> {
  if (!/\.(?:db|sqlite3?|db3)$/i.test(absolute)) return {};
  let db: import("bun:sqlite").Database | undefined;
  try {
    const { Database } = await import("bun:sqlite");
    db = new Database(absolute, { readonly: true });
    const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>)
      .map((table) => table.name);
    let rows = 0;
    for (const table of tables) rows += (db.query(`SELECT count(*) AS n FROM "${table.replaceAll('"', '""')}"`).get() as { n: number }).n;
    return { rows, tables: tables.length };
  } catch { return {}; } finally { db?.close(); }
}

const holds = (entry: TestData) => entry.rows === undefined ? "" : ` (${entry.rows} ${entry.rows === 1 ? "row" : "rows"} in ${entry.tables} ${entry.tables === 1 ? "table" : "tables"})`;
const named = (entries: readonly TestData[]) => entries.map((entry) => `${entry.file}${holds(entry)}`).join(", ");

/** The end note to the AI, sent once when its own runs left data behind. */
export function testDataNote(entries: readonly TestData[]): string {
  return `Casper: your own runs this task (a server or tests you started) left ${named(entries)}. It is test data: an app that creates it on start doesn't need it, and shipped, a fresh install starts with those rows. Delete it, with its -wal and -shm files, unless it is meant to ship; then answer in one line.`;
}

/** The line Casper prints when it sends the note. */
export function testDataNotice(entries: readonly TestData[]): string {
  return `↻ ${named(entries)}: left by this task's own runs; asking the AI to remove it unless it ships`;
}

/** The receipt's line for test data still there at the end. */
export const TEST_DATA_LEFT = "Left by your test runs";
export function testDataLine(entries: readonly TestData[], safe: (text: string) => string): string {
  return `– ${TEST_DATA_LEFT}: ${safe(named(entries))}; it ships with the app unless you delete it`;
}
