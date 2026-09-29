import type { VerificationResult } from "./evidence";
import { detectMigrations, migrationsScope, runMigrationsCheck, type MigrationPlan, type MigrationsReport } from "./migrations";
import type { VerificationScope } from "./scope";

/**
 * The SQL migrations check as a named check: Casper finds it from the project's own files (see migrations.ts),
 * so no command is configured. It runs after each change that touches the migrations (or the Prisma schema),
 * next to typecheck, lint, test and build, and through /verify migrations and the AI's casper_check. A project
 * that names its own `migrations` check under verify.checks keeps it; the detected one is then left out.
 */
export const MIGRATIONS_CHECK = "migrations";

/** What the check says it does, for the live line and the AI's list of checks. */
export const MIGRATIONS_COMMAND = "apply the SQL migrations to a throwaway SQLite";

interface MigrationsModel { migrations?: MigrationPlan; namedChecks?: Record<string, unknown> }

/** The detected migrations, unless the project named its own check `migrations`. */
export function detectedMigrations(model: MigrationsModel): MigrationPlan | undefined {
  return model.migrations && !model.namedChecks?.[MIGRATIONS_CHECK] ? model.migrations : undefined;
}

/** Whether Casper can apply them: clearly SQLite, and a Prisma schema that reads its address from a variable. */
export function migrationsRunnable(plan: MigrationPlan): boolean {
  return plan.dialect === "sqlite" && !(plan.kind === "prisma" && !plan.envName);
}

/** Detected checks that run after each change, with the files that make them worth running. Migrations Casper
 * can't apply (Postgres, a literal Prisma address) are left out: they run only with /verify migrations, which
 * says why they were not checked. */
export function autoDetectedChecks(model: MigrationsModel): Array<{ name: string; scope: VerificationScope }> {
  const plan = detectedMigrations(model);
  return plan && migrationsRunnable(plan) ? [{ name: MIGRATIONS_CHECK, scope: migrationsScope(plan) }] : [];
}

/** A migrations run as check evidence. A failure names the file and the database error; "not checked" is a
 * skip that is never handed to the model to fix. */
export function migrationsResult(report: MigrationsReport, cwd: string): VerificationResult {
  // No command: Casper applies the files itself, so the label says what ran.
  const base = { name: MIGRATIONS_CHECK, cwd, signal: null, stdout: "", truncated: false, durationMs: report.durationMs };
  if (report.status === "pass") {
    return { ...base, status: "pass", exitCode: 0, stderr: "", label: `${report.files} file${report.files === 1 ? "" : "s"} · throwaway SQLite` };
  }
  if (report.status === "fail") {
    const failure = `${report.failed?.file ?? "a migration"} failed — ${report.failed?.error ?? "unknown error"}`;
    // No exit code: the reason is what the receipt shows ("✗ migrations failed (002_devices.sql failed — …)").
    return { ...base, status: "fail", exitCode: null, stderr: failure, reason: failure };
  }
  return { ...base, status: "skip", exitCode: null, stderr: "", reason: report.reason ?? "not checked", repair: "never" };
}

/** Runs the check on the project's migrations as they are now: files the change added count too. The folder
 * found when the project was opened is the one checked; one that is gone is "not checked", never a pass. */
export async function runDetectedMigrations(root: string, found: MigrationPlan, signal?: AbortSignal): Promise<VerificationResult> {
  const now = await detectMigrations(root).catch(() => undefined);
  if (!now || now.dir !== found.dir) {
    return migrationsResult({ status: "skip", files: 0, durationMs: 0, reason: `no migrations are left in ${found.dir}` }, root);
  }
  return migrationsResult(await runMigrationsCheck(root, now, signal ?? new AbortController().signal), root);
}
