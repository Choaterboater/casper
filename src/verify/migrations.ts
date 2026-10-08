import { spawn } from "node:child_process";
import { lstat, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isolatedEnvironment } from "../platform/environment";
import { sandboxedArgv, sandboxPath, type SandboxedSpawn } from "../sandbox/spawn";
import { blockedBySandbox } from "./command";
import type { VerificationScope } from "./scope";

/**
 * The migrations check: applies the project's SQL migrations, in order, to a throwaway SQLite database
 * that is deleted afterwards. The project's own database files are never opened. The database dialect
 * comes only from the project itself (schema.prisma's provider, drizzle.config's dialect, the database
 * driver it depends on, supabase/migrations); anything that is not clearly SQLite is "not checked", with
 * the reason. Casper never guesses a dialect.
 */

export type MigrationDialect = "sqlite" | "postgres" | "mysql" | "unknown";
export interface MigrationPlan {
  kind: "sql-files" | "prisma";
  /** Project-relative folder of the migrations. */
  dir: string;
  /** Project-relative files in the order they apply. */
  files: string[];
  dialect: MigrationDialect;
  /** Where the dialect came from, in the user's words ("schema.prisma", "drizzle.config.ts", "the better-sqlite3 dependency"). */
  dialectSource?: string;
  /** Prisma: the project-relative schema, and the variable its datasource url reads (or a literal url). */
  schema?: string;
  envName?: string;
  literalUrl?: boolean;
}
export interface MigrationsReport {
  /** skip: not checked, with the reason. */
  status: "pass" | "fail" | "skip";
  files: number;
  failed?: { file: string; error: string };
  /** fail: the sandbox stopped prisma ("blocked by the sandbox (...)"), so it is not the migrations failing. */
  blocked?: string;
  reason?: string;
  durationMs: number;
}

const MIGRATION_DIRS = ["migrations", "db/migrations", "sql/migrations", "drizzle", "supabase/migrations"];
const PRISMA_SCHEMAS = ["prisma/schema.prisma", "schema.prisma"];
const DRIZZLE_CONFIGS = ["drizzle.config.ts", "drizzle.config.js", "drizzle.config.mjs", "drizzle.config.cjs", "drizzle.config.json"];
const MAX_FILES = 500;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SMALL = 256 * 1024;
const APPLY_TIMEOUT_MS = 60_000;

const SQLITE_JS = ["better-sqlite3", "sqlite3", "sqlite", "@libsql/client", "libsql"];
const POSTGRES_JS = ["pg", "postgres", "@neondatabase/serverless", "@vercel/postgres", "pg-promise", "@electric-sql/pglite"];
const MYSQL_JS = ["mysql", "mysql2"];
const POSTGRES_PY = /^\s*(psycopg2?|psycopg2-binary|psycopg\[.*\]|asyncpg|pg8000)\b/im;
const MYSQL_PY = /^\s*(pymysql|mysqlclient|mysql-connector-python|aiomysql)\b/im;
const SCAN_SKIP = new Set(["node_modules", ".git", ".venv", "venv", "dist", "build", ".next", "__pycache__", "coverage"]);

const natural = (left: string, right: string) => left.localeCompare(right, "en", { numeric: true });

async function small(file: string, limit = MAX_SMALL): Promise<string | undefined> {
  try { const details = await lstat(file); return details.isFile() && details.size <= limit ? await readFile(file, "utf8") : undefined; } catch { return undefined; }
}
async function entries(dir: string): Promise<Array<{ name: string; dir: boolean; file: boolean }>> {
  try { return (await readdir(dir, { withFileTypes: true })).map(entry => ({ name: entry.name, dir: entry.isDirectory(), file: entry.isFile() })); } catch { return []; }
}

/** Whether any source file (bounded walk) contains the pattern: `bun:sqlite` or Python's `import sqlite3`. */
async function sourceImports(root: string, extensions: RegExp, pattern: RegExp): Promise<boolean> {
  let budget = 400;
  const walk = async (dir: string, depth: number): Promise<boolean> => {
    for (const entry of await entries(dir)) {
      if (budget <= 0) return false;
      if (entry.dir && depth < 4 && !SCAN_SKIP.has(entry.name) && !entry.name.startsWith(".")) { if (await walk(path.join(dir, entry.name), depth + 1)) return true; }
      else if (entry.file && extensions.test(entry.name)) {
        budget--;
        if (pattern.test(await small(path.join(dir, entry.name)) ?? "")) return true;
      }
    }
    return false;
  };
  return walk(root, 0);
}

/** The dialect from the project's own dependencies: one database family, or unknown when none or several. */
async function driverDialect(root: string): Promise<{ dialect: MigrationDialect; source?: string }> {
  const found = new Map<MigrationDialect, string>();
  try {
    const manifest = JSON.parse(await small(path.join(root, "package.json")) ?? "{}") as Record<string, unknown>;
    const deps = new Set<string>();
    for (const section of ["dependencies", "devDependencies"]) {
      const value = manifest[section];
      if (value && typeof value === "object" && !Array.isArray(value)) for (const name of Object.keys(value)) deps.add(name);
    }
    for (const [dialect, names] of [["sqlite", SQLITE_JS], ["postgres", POSTGRES_JS], ["mysql", MYSQL_JS]] as const) {
      const name = names.find(entry => deps.has(entry));
      if (name) found.set(dialect, `the ${name} dependency`);
    }
  } catch { /* no usable package.json */ }
  const python = [await small(path.join(root, "pyproject.toml")) ?? "",
    ...(await Promise.all((await entries(root)).filter(entry => entry.file && /^requirements[\w.-]*\.txt$/i.test(entry.name)).map(entry => small(path.join(root, entry.name))))).map(text => text ?? "")].join("\n");
  if (POSTGRES_PY.test(python) || /["']\s*(psycopg2?|asyncpg|pg8000)\b/i.test(python)) found.set("postgres", found.get("postgres") ?? "a Postgres driver in the Python requirements");
  if (MYSQL_PY.test(python) || /["']\s*(pymysql|mysqlclient|aiomysql)\b/i.test(python)) found.set("mysql", found.get("mysql") ?? "a MySQL driver in the Python requirements");
  if (!found.has("sqlite") && await sourceImports(root, /\.(ts|tsx|js|mjs|cjs)$/, /["']bun:sqlite["']/)) found.set("sqlite", "a bun:sqlite import");
  if (!found.has("sqlite") && await sourceImports(root, /\.py$/, /^\s*(import\s+sqlite3|from\s+sqlite3\s+import)\b/m)) found.set("sqlite", "a Python sqlite3 import");
  if (found.size !== 1) return { dialect: "unknown" };
  const [[dialect, source]] = [...found];
  return { dialect, source };
}

function drizzleDialect(source: string): MigrationDialect | undefined {
  const dialect = /\bdialect\s*:\s*["'](\w+)["']/.exec(source)?.[1] ?? /"dialect"\s*:\s*"(\w+)"/.exec(source)?.[1];
  const driver = /\bdriver\s*:\s*["']([\w-]+)["']/.exec(source)?.[1];
  const name = (dialect ?? driver ?? "").toLowerCase();
  if (["sqlite", "turso", "better-sqlite", "libsql", "d1", "d1-http", "expo", "durable-sqlite"].includes(name)) return "sqlite";
  if (["postgresql", "postgres", "pg", "pglite", "aws-data-api"].includes(name)) return "postgres";
  if (["mysql", "mysql2", "singlestore"].includes(name)) return "mysql";
  return undefined;
}

/** SQL files of one folder in the order they apply: golang-migrate `.up.sql` only when the folder uses them; never `.down.sql`. */
async function sqlFiles(root: string, dir: string): Promise<string[]> {
  const names = (await entries(path.join(root, dir))).filter(entry => entry.file && /\.sql$/i.test(entry.name)).map(entry => entry.name);
  const ups = names.filter(name => /\.up\.sql$/i.test(name));
  return (ups.length ? ups : names.filter(name => !/\.down\.sql$/i.test(name))).sort(natural).map(name => `${dir}/${name}`);
}

/** Finds the project's migrations and the database they are for, or undefined when it has none. */
export async function detectMigrations(root: string): Promise<MigrationPlan | undefined> {
  for (const schema of PRISMA_SCHEMAS) {
    const source = await small(path.join(root, schema));
    if (source === undefined) continue;
    const dir = `${path.posix.dirname(schema) === "." ? "" : `${path.posix.dirname(schema)}/`}migrations`;
    const folders = (await entries(path.join(root, dir))).filter(entry => entry.dir).map(entry => entry.name).sort(natural);
    const files: string[] = [];
    for (const folder of folders) if ((await lstat(path.join(root, dir, folder, "migration.sql")).catch(() => undefined))?.isFile()) files.push(`${dir}/${folder}/migration.sql`);
    if (!files.length) break;
    const datasource = /datasource\s+\w+\s*\{([^}]*)\}/s.exec(source)?.[1] ?? "";
    const provider = /\bprovider\s*=\s*"(\w+)"/.exec(datasource)?.[1]?.toLowerCase();
    const envName = /\burl\s*=\s*env\(\s*"([A-Za-z_][A-Za-z0-9_]*)"\s*\)/.exec(datasource)?.[1];
    const dialect: MigrationDialect = provider === "sqlite" ? "sqlite" : provider === "postgresql" || provider === "cockroachdb" ? "postgres" : provider === "mysql" ? "mysql" : "unknown";
    return { kind: "prisma", dir, files, dialect, dialectSource: schema, schema, ...(envName ? { envName } : { literalUrl: /\burl\s*=\s*"/.test(datasource) }) };
  }
  for (const dir of MIGRATION_DIRS) {
    const files = await sqlFiles(root, dir);
    if (!files.length) continue;
    if (dir === "supabase/migrations") return { kind: "sql-files", dir, files, dialect: "postgres", dialectSource: "supabase/migrations" };
    for (const config of DRIZZLE_CONFIGS) {
      const dialect = drizzleDialect(await small(path.join(root, config)) ?? "");
      if (dialect) return { kind: "sql-files", dir, files, dialect, dialectSource: config };
    }
    const driver = await driverDialect(root);
    return { kind: "sql-files", dir, files, dialect: driver.dialect, ...(driver.source ? { dialectSource: driver.source } : {}) };
  }
  return undefined;
}

/** The inputs whose edits make the check worth running: the migrations and, for Prisma, the schema. */
export function migrationsScope(plan: MigrationPlan): VerificationScope {
  return { inputs: [plan.dir, ...(plan.schema ? [plan.schema] : [])] };
}
/** Whether any changed project-relative path is inside the check's scope; unrelated edits never run it. */
export function migrationsAffected(plan: MigrationPlan, changedPaths: readonly string[]): boolean {
  const inputs = migrationsScope(plan).inputs;
  return changedPaths.some(raw => {
    const file = raw.replace(/\\/g, "/").replace(/^\.\//, "");
    return inputs.some(input => file === input || file.startsWith(`${input}/`));
  });
}

/** The statements of one migration file to apply, as separate chunks: the `-- migrate:up` section of a
 * dbmate file (never its down section), split at drizzle's `--> statement-breakpoint`. */
export function migrationParts(source: string): string[] {
  let body = source;
  const up = /^--\s*migrate:up\b.*$/m.exec(body);
  if (up) {
    body = body.slice(up.index + up[0].length);
    const down = /^--\s*migrate:down\b/m.exec(body);
    if (down) body = body.slice(0, down.index);
  }
  return body.split(/^-->\s*statement-breakpoint\s*$/m).map(part => part.trim()).filter(Boolean);
}

/** Statements that reach outside the throwaway database: attaching or writing another file, or loading code. */
const OUTSIDE = /\b(ATTACH\b|VACUUM\s+INTO\b|load_extension\s*\()/i;
/** What SQLite will execute, with string literals and comments blanked in ONE left-to-right pass, so a quote inside a
 * comment (or a comment marker inside a string) cannot hide a keyword. Quoted names keep their text (a quoted
 * function name still runs), which only makes the check stricter. Undefined when the text ends inside a string, a
 * quoted name or a block comment: the caller refuses it. */
export function executableSql(sql: string): string | undefined {
  let out = "";
  for (let i = 0; i < sql.length;) {
    const c = sql[i]!;
    if (c === "-" && sql[i + 1] === "-") { const end = sql.indexOf("\n", i); if (end < 0) break; out += " "; i = end; continue; }
    if (c === "/" && sql[i + 1] === "*") { const end = sql.indexOf("*/", i + 2); if (end < 0) return undefined; out += " "; i = end + 2; continue; }
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      let j = i + 1, text = "";
      for (;;) {
        if (j >= sql.length) return undefined;
        if (sql[j] === close) { if (close !== "]" && sql[j + 1] === close) { text += close; j += 2; continue; } break; }
        text += sql[j++];
      }
      out += c === "'" ? "''" : ` ${text} `; i = j + 1; continue;
    }
    out += c; i++;
  }
  return out;
}
/** True when a migration part may reach outside the throwaway database, or cannot be read with certainty. */
export function reachesOutside(part: string): boolean {
  const code = executableSql(part);
  return code === undefined || OUTSIDE.test(code);
}

const APPLY = `
const { Database } = require("bun:sqlite");
const input = JSON.parse(await Bun.stdin.text());
const db = new Database(input.db, { create: true, strict: true });
let applied = 0, failed;
for (const file of input.files) {
  try { for (const part of file.parts) db.exec(part); applied++; }
  catch (error) { failed = { file: file.name, error: String(error && error.message || error).split("\\n")[0].slice(0, 500) }; break; }
}
db.close();
process.stdout.write(JSON.stringify({ applied, failed }));`;

async function applySqlite(files: Array<{ name: string; parts: string[] }>, dir: string, signal: AbortSignal): Promise<{ applied: number; failed?: { file: string; error: string } } | string> {
  // A child of Casper's own runtime, so a runaway statement never blocks Casper and is killed on time.
  const child = Bun.spawn([process.execPath, "-e", APPLY], { cwd: dir, stdin: new Blob([JSON.stringify({ db: path.join(dir, "check.db"), files })]),
    stdout: "pipe", stderr: "pipe", env: isolatedEnvironment(dir, { BUN_BE_BUN: "1" }), timeout: APPLY_TIMEOUT_MS, killSignal: "SIGKILL", signal });
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  signal.throwIfAborted();
  if (child.signalCode) return `applying the migrations took longer than ${APPLY_TIMEOUT_MS / 1000} s`;
  try { return JSON.parse(out) as { applied: number; failed?: { file: string; error: string } }; }
  catch { return `the throwaway database could not be set up (${(err.trim().split("\n").at(-1) ?? "").slice(0, 300) || `exit ${child.exitCode}`})`; }
}

async function prismaDeploy(root: string, plan: MigrationPlan, dir: string, signal: AbortSignal): Promise<{ ok: true } | { ok: false; file?: string; error: string; blocked?: string }> {
  const bin = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "prisma.cmd" : "prisma");
  const env = isolatedEnvironment(dir, { PATH: `${path.join(root, "node_modules", ".bin")}${path.delimiter}${process.env.PATH ?? ""}`,
    // Only the database address is given, and it points at the throwaway copy.
    [plan.envName!]: `file:${path.join(dir, "check.db")}`, CHECKPOINT_DISABLE: "1", PRISMA_HIDE_UPDATE_MESSAGE: "1", npm_config_offline: "true" });
  // The prisma under node_modules is the project's own code: it runs in the session's shell sandbox like every
  // other check, with no network (the throwaway database is in temp).
  let run: SandboxedSpawn;
  try { run = await sandboxedArgv(bin, ["migrate", "deploy", "--schema", plan.schema!], { cwd: root, network: "none" }); }
  catch (error) { return { ok: false, error: `prisma could not start in the sandbox (${error instanceof Error ? error.message : String(error)})`.slice(0, 300) }; }
  try { return await new Promise(resolve => {
    const child = spawn(run.file, run.args, { cwd: root, env: sandboxPath(env, Boolean(run.held)), shell: run.shell || process.platform === "win32", stdio: ["ignore", "pipe", "pipe"], signal, timeout: APPLY_TIMEOUT_MS, killSignal: "SIGKILL" });
    let output = "";
    const keep = (chunk: Buffer) => { output = (output + chunk.toString("utf8")).slice(-16_384); };
    child.stdout.on("data", keep); child.stderr.on("data", keep);
    child.on("error", error => resolve({ ok: false, error: error.message.slice(0, 300) }));
    child.on("close", async (code, killed) => {
      if (code === 0) return resolve({ ok: true });
      const migration = /Migration name:\s*(\S+)/.exec(output)?.[1];
      const error = /(?:Database error[^:\n]*:|Error:)\s*\n?\s*(.+)/.exec(output)?.[1]?.trim() ?? output.trim().split("\n").filter(Boolean).at(-1) ?? `exit ${code ?? killed}`;
      // A failure the sandbox caused says so, as every other check's does, and is never sent for repair.
      const blocked = run.held ? await blockedBySandbox(run.held.sandbox, run.held.id, output) : undefined;
      resolve({ ok: false, ...(migration ? { file: migration } : {}), error: error.slice(0, 500), ...(blocked ? { blocked } : {}) });
    });
  }); } finally { run.held?.sandbox.finished(run.held.id); }
}

const DIALECT_NAMES: Record<MigrationDialect, string> = { sqlite: "SQLite", postgres: "Postgres", mysql: "MySQL", unknown: "" };

/** Applies the plan's migrations to a throwaway SQLite database, which is removed afterwards. */
export async function runMigrationsCheck(root: string, plan: MigrationPlan, signal: AbortSignal): Promise<MigrationsReport> {
  const began = performance.now();
  const done = (report: Omit<MigrationsReport, "durationMs" | "files"> & { files?: number }): MigrationsReport =>
    ({ files: plan.files.length, ...report, durationMs: Math.round(performance.now() - began) });
  if (plan.dialect !== "sqlite") {
    if (plan.dialect === "unknown") return done({ status: "skip", reason: "Casper can't tell which database these are for. It only checks SQLite projects (a SQLite driver, drizzle.config dialect, or schema.prisma provider)" });
    return done({ status: "skip", reason: `these are ${DIALECT_NAMES[plan.dialect]} migrations (${plan.dialectSource}), and Casper only has a throwaway SQLite` });
  }
  if (plan.kind === "prisma" && !plan.envName) {
    return done({ status: "skip", reason: `${path.posix.basename(plan.schema!)} writes the database address directly, so Casper can't point it at a throwaway copy` });
  }
  if (plan.kind === "prisma" && !(await lstat(path.join(root, "node_modules", ".bin", process.platform === "win32" ? "prisma.cmd" : "prisma")).catch(() => undefined))) {
    return done({ status: "skip", reason: "prisma is not in node_modules. Install the project's packages first (Casper doesn't install packages)" });
  }
  const files: Array<{ name: string; parts: string[] }> = [];
  if (plan.files.length > MAX_FILES) return done({ status: "skip", reason: `there are ${plan.files.length} migration files; Casper checks at most ${MAX_FILES}` });
  for (const file of plan.files) {
    const source = await small(path.join(root, file), MAX_FILE_BYTES);
    if (source === undefined) return done({ status: "skip", reason: `${file} could not be read (or is over 2 MB)` });
    const parts = migrationParts(source);
    if (parts.some(reachesOutside)) {
      return done({ status: "skip", reason: `${fileLabel(file)} uses ATTACH, VACUUM INTO or load_extension, which can reach files outside the throwaway database` });
    }
    files.push({ name: fileLabel(file), parts });
  }
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-migrations-")));
  try {
    signal.throwIfAborted();
    if (plan.kind === "prisma") {
      const result = await prismaDeploy(root, plan, dir, signal);
      signal.throwIfAborted();
      if (result.ok) return done({ status: "pass" });
      return result.blocked ? done({ status: "fail", blocked: result.blocked }) : done({ status: "fail", failed: { file: result.file ?? "prisma migrate deploy", error: result.error } });
    }
    const result = await applySqlite(files, dir, signal);
    if (typeof result === "string") return done({ status: "skip", reason: result });
    return result.failed ? done({ status: "fail", failed: result.failed }) : done({ status: "pass" });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** A migration's name for the user: the file name, or the folder name of a Prisma migration. */
function fileLabel(file: string): string {
  const parts = file.split("/");
  return parts.at(-1) === "migration.sql" && parts.length > 1 ? parts.at(-2)! : parts.at(-1)!;
}

/** The receipt line. */
export function formatMigrationsLine(report: MigrationsReport): string {
  if (report.status === "pass") return `✓ migrations apply · ${report.files} file${report.files === 1 ? "" : "s"} · throwaway SQLite`;
  if (report.status === "fail") return report.blocked ? `✗ migrations — ${report.blocked}` : `✗ migrations: ${report.failed?.file} failed — ${report.failed?.error}`;
  return `• migrations not checked: ${report.reason}`;
}
