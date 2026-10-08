import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { detectMigrations, formatMigrationsLine, migrationParts, migrationsAffected, reachesOutside, runMigrationsCheck } from "../src/verify/migrations";
import { removeTempDir } from "./support/temp-dir";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function project(files: Record<string, string>) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-migrations-test-")));
  cleanups.push(() => removeTempDir(root));
  for (const [name, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), text); }
  return root;
}
const sqlitePkg = JSON.stringify({ dependencies: { "better-sqlite3": "11" } });
const signal = () => new AbortController().signal;
const SITES = "CREATE TABLE sites (id INTEGER PRIMARY KEY, name TEXT NOT NULL);";
const DEVICES = "CREATE TABLE devices (id INTEGER PRIMARY KEY, site_id INTEGER REFERENCES sites(id));\nINSERT INTO sites (name) VALUES ('hq');";

test("ordered .sql files apply to a throwaway SQLite, and the project's real database is never touched", async () => {
  const root = await project({ "package.json": sqlitePkg, "migrations/001_sites.sql": SITES, "migrations/002_devices.sql": DEVICES });
  const real = new Database(path.join(root, "app.db"));
  real.exec("CREATE TABLE keep (x); INSERT INTO keep VALUES (1);"); real.close();
  const hash = async () => createHash("sha256").update(await readFile(path.join(root, "app.db"))).digest("hex");
  const before = await hash();
  const plan = (await detectMigrations(root))!;
  expect(plan).toMatchObject({ kind: "sql-files", dir: "migrations", files: ["migrations/001_sites.sql", "migrations/002_devices.sql"], dialect: "sqlite", dialectSource: "the better-sqlite3 dependency" });
  const report = await runMigrationsCheck(root, plan, signal());
  expect(formatMigrationsLine(report)).toBe("✓ migrations apply · 2 files · throwaway SQLite");
  expect(await hash()).toBe(before);
});

test("a broken migration names the file and SQLite's error", async () => {
  const root = await project({ "package.json": sqlitePkg, "migrations/001_init.sql": "CREATE TABLE a (x);", "migrations/002_devices.sql": DEVICES });
  const report = await runMigrationsCheck(root, (await detectMigrations(root))!, signal());
  expect(report.status).toBe("fail");
  expect(formatMigrationsLine(report)).toBe("✗ migrations: 002_devices.sql failed — no such table: sites");
});

test("files apply in natural order, and golang-migrate folders apply only .up.sql", async () => {
  const root = await project({ "package.json": sqlitePkg, "db/migrations/10_devices.up.sql": DEVICES, "db/migrations/2_sites.up.sql": SITES,
    "db/migrations/2_sites.down.sql": "DROP TABLE sites;", "db/migrations/10_devices.down.sql": "DROP TABLE devices;" });
  const plan = (await detectMigrations(root))!;
  expect(plan.files).toEqual(["db/migrations/2_sites.up.sql", "db/migrations/10_devices.up.sql"]);
  expect((await runMigrationsCheck(root, plan, signal())).status).toBe("pass");
});

test("dbmate files apply only their up section; drizzle files split at statement breakpoints", async () => {
  expect(migrationParts("-- migrate:up\nCREATE TABLE a (x);\n\n-- migrate:down\nDROP TABLE a;\n")).toEqual(["CREATE TABLE a (x);"]);
  expect(migrationParts("CREATE TABLE a (x);\n--> statement-breakpoint\nCREATE TABLE b (y);\n")).toEqual(["CREATE TABLE a (x);", "CREATE TABLE b (y);"]);
  const root = await project({ "drizzle.config.ts": "export default { dialect: 'sqlite', out: './drizzle' };",
    "drizzle/0000_init.sql": `${SITES}\n--> statement-breakpoint\nCREATE INDEX sites_name ON sites (name);`,
    "drizzle/0001_more.sql": "-- migrate:up\nCREATE TABLE extra (x);\n-- migrate:down\nDROP TABLE sites;\nSELECT * FROM missing_table;\n" });
  const plan = (await detectMigrations(root))!;
  expect(plan).toMatchObject({ dir: "drizzle", dialect: "sqlite", dialectSource: "drizzle.config.ts" });
  expect(formatMigrationsLine(await runMigrationsCheck(root, plan, signal()))).toBe("✓ migrations apply · 2 files · throwaway SQLite");
});

test("Postgres and unknown databases are not checked, with the reason from the project", async () => {
  const supabase = await project({ "supabase/migrations/20240101_init.sql": "create extension if not exists pgcrypto;" });
  const plan = (await detectMigrations(supabase))!;
  expect(plan.dialect).toBe("postgres");
  expect(formatMigrationsLine(await runMigrationsCheck(supabase, plan, signal()))).toBe("• migrations not checked: these are Postgres migrations (supabase/migrations), and Casper only has a throwaway SQLite");
  const pg = await project({ "package.json": JSON.stringify({ dependencies: { pg: "8" } }), "migrations/001.sql": SITES });
  expect(formatMigrationsLine(await runMigrationsCheck(pg, (await detectMigrations(pg))!, signal()))).toContain("Postgres migrations (the pg dependency)");
  // Both drivers, or none: Casper never guesses.
  const both = await project({ "package.json": JSON.stringify({ dependencies: { pg: "8", "better-sqlite3": "11" } }), "migrations/001.sql": SITES });
  expect((await detectMigrations(both))!.dialect).toBe("unknown");
  const none = await project({ "migrations/001.sql": SITES });
  expect(formatMigrationsLine(await runMigrationsCheck(none, (await detectMigrations(none))!, signal()))).toStartWith("• migrations not checked: Casper can't tell which database these are for");
  // Python's sqlite3 counts only with no other database driver.
  const py = await project({ "requirements.txt": "flask\n", "app/db.py": "import sqlite3\n", "migrations/001.sql": SITES });
  expect((await detectMigrations(py))!).toMatchObject({ dialect: "sqlite", dialectSource: "a Python sqlite3 import" });
  const pyPg = await project({ "requirements.txt": "psycopg2-binary\n", "app/db.py": "import sqlite3\n", "migrations/001.sql": SITES });
  expect((await detectMigrations(pyPg))!.dialect).toBe("unknown");
});

test("statements that reach outside the throwaway database are refused, not run", async () => {
  const root = await project({ "package.json": sqlitePkg, "migrations/001.sql": "ATTACH DATABASE 'app.db' AS real; DROP TABLE real.keep;" });
  expect(formatMigrationsLine(await runMigrationsCheck(root, (await detectMigrations(root))!, signal())))
    .toBe("• migrations not checked: 001.sql uses ATTACH, VACUUM INTO or load_extension, which can reach files outside the throwaway database");
  // A comment or a string that mentions it is fine.
  const ok = await project({ "package.json": sqlitePkg, "migrations/001.sql": "-- never ATTACH here\nCREATE TABLE notes (body TEXT DEFAULT 'attach later');" });
  expect((await runMigrationsCheck(ok, (await detectMigrations(ok))!, signal())).status).toBe("pass");
});

test("a Prisma schema with a literal url is refused; an env url gets only a throwaway file address", async () => {
  const literal = await project({ "prisma/schema.prisma": 'datasource db {\n  provider = "sqlite"\n  url      = "file:./dev.db"\n}\n', "prisma/migrations/20240101_init/migration.sql": SITES });
  const plan = (await detectMigrations(literal))!;
  expect(plan).toMatchObject({ kind: "prisma", dialect: "sqlite", literalUrl: true, files: ["prisma/migrations/20240101_init/migration.sql"] });
  expect(formatMigrationsLine(await runMigrationsCheck(literal, plan, signal()))).toBe("• migrations not checked: schema.prisma writes the database address directly, so Casper can't point it at a throwaway copy");
  if (process.platform === "win32") return;
  const env = await project({ "prisma/schema.prisma": 'datasource db {\n  provider = "sqlite"\n  url      = env("DATABASE_URL")\n}\n', "prisma/migrations/20240101_init/migration.sql": SITES,
    // A stand-in for the prisma CLI that records what it was given; no real prisma runs.
    "node_modules/.bin/prisma": `#!/bin/sh\nprintf '%s\\n%s\\n' "$DATABASE_URL" "\${OPENAI_API_KEY:-none}" > "${"$"}{PWD}/seen.txt"\nexit 0\n` });
  await chmod(path.join(env, "node_modules/.bin/prisma"), 0o755);
  process.env.OPENAI_API_KEY = "sk-test-should-not-pass";
  cleanups.push(() => { delete process.env.OPENAI_API_KEY; });
  const envPlan = (await detectMigrations(env))!;
  expect(envPlan).toMatchObject({ envName: "DATABASE_URL", schema: "prisma/schema.prisma" });
  expect((await runMigrationsCheck(env, envPlan, signal())).status).toBe("pass");
  const [url, key] = (await readFile(path.join(env, "seen.txt"), "utf8")).split("\n");
  expect(url).toMatch(/^file:.*casper-migrations-[^/]+\/check\.db$/);
  expect(url).not.toContain(env);
  expect(key).toBe("none");
});

test("the check runs only when migrations or the schema changed", async () => {
  const root = await project({ "package.json": sqlitePkg, "migrations/001.sql": SITES });
  const plan = (await detectMigrations(root))!;
  expect(migrationsAffected(plan, ["src/app.ts", "README.md"])).toBe(false);
  expect(migrationsAffected(plan, ["migrations/002.sql"])).toBe(true);
  expect(await detectMigrations(await project({ "src/app.ts": "" }))).toBeUndefined();
});

test("a quote next to a comment marker cannot hide ATTACH, VACUUM INTO or load_extension", () => {
  const sneaky = [
    "SELECT '/*'; ATTACH DATABASE 'x.db' AS o; --*/",
    "SELECT 'a--'; ATTACH 'x.db' AS o",
    "SELECT 1 /* ' */; ATTACH 'x.db' AS o; SELECT '",
    "VACUUM INTO 'out.db'",
    "SELECT \"load_extension\"('x')",
    "ATTACH/**/DATABASE 'x.db' AS o",
    "SELECT 'unterminated",
    "SELECT 1 /* never closed",
  ];
  for (const sql of sneaky) expect({ sql, refused: reachesOutside(sql) }).toEqual({ sql, refused: true });
  for (const sql of ["-- ATTACH\nSELECT 1", "SELECT 'ATTACH ''x'' -- no'", "/* VACUUM INTO */ CREATE TABLE t (a TEXT DEFAULT '/*')", "CREATE TABLE t (a); -- it's fine"]) {
    expect({ sql, refused: reachesOutside(sql) }).toEqual({ sql, refused: false });
  }
});
