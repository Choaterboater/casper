import type { ProjectModel } from "../project/model";
import type { NetworkCheckContext } from "../network/checks";
import { JUNOSER_NOTE, type NetworkCheckResult } from "../network/spec";
import { runCommandCheck, type CommandWrap } from "./command";
import { CHECK_NAMES, type CheckName, type VerificationResult } from "./evidence";
import { isBuiltinCheck, labOnlyByYou, modelNamedChecks, type NamedCheckSpec } from "./named";
import { detectedMigrations, MIGRATIONS_CHECK, migrationsRunnable, runDetectedMigrations } from "./migrations-check";
import { migrationsScope } from "./migrations";
import { detectedE2e, E2E_CHECK, e2eNotInstalled, e2eResult } from "./e2e";
import type { VerificationScope } from "./scope";

export interface Verifier {
  name: CheckName;
  scope?: VerificationScope;
  /** Unset: an ordinary pass/fail check. See VerificationResult.kind. */
  kind?: "report" | "lab";
  /** The command it runs, when it is one: tells whether a result recorded under another registry is still this check's. */
  command?: string;
  /** False: a check that can only skip (a built-in with no command, migrations Casper can't apply). The AI isn't offered it; /verify <name> still reports it. */
  runnable?: false;
  /** `timeoutMs`: a longer limit the user gave an unfinished check ("Allow more time"), at most one hour. */
  run(signal?: AbortSignal, options?: { timeoutMs?: number }): Promise<VerificationResult>;
}

/** Runs one named check that uses a ready-made preset. Casper passes its network check runner; tests pass a fake. */
export type NamedCheckRunner = (name: string, spec: NamedCheckSpec, context: { cwd: string; signal?: AbortSignal; timeoutMs: number }) => Promise<VerificationResult>;

/** Where network presets find their tools and private folders (tests point these at fakes). */
export type NetworkToolContext = Pick<NetworkCheckContext, "path" | "tmpRoot" | "realHome" | "platform">;

export interface ForProjectOptions {
  /** Rewrites how each command check starts (the shell sandbox). */
  wrap?: CommandWrap;
  /** Runs preset named checks; defaults to Casper's network check runner. */
  runPreset?: NamedCheckRunner;
  /** Runs a device (lab) check after asking the person in a numbered box (the app passes one for /verify and for the
   * AI's casper_check in an interactive session). Without it a lab check never starts. */
  runLab?: NamedCheckRunner;
  /** Tool PATH, temp folder and home for the default preset runner. */
  network?: NetworkToolContext;
}

const nothing = { exitCode: null, signal: null, stdout: "", stderr: "", truncated: false, durationMs: 0 } as const;

/** A network check result as verification evidence. Its output is already scrubbed. */
export function fromNetworkResult(result: NetworkCheckResult): VerificationResult {
  const summary = result.report ? `${result.report.changeLines} lines to change · ${result.report.undoLines} to undo` : undefined;
  return {
    name: result.name, status: result.status, command: result.command, cwd: result.cwd, exitCode: result.exitCode, signal: result.signal,
    stdout: result.stdout, stderr: result.stderr, truncated: result.truncated, durationMs: result.durationMs,
    ...(result.reason ? { reason: result.reason } : {}), ...(result.ended ? { ended: result.ended } : {}),
    ...(result.kind !== "offline" ? { kind: result.kind } : {}), ...(result.label ? { label: result.label } : {}),
    ...(result.hosts ? { hosts: [...result.hosts] } : {}), ...(summary ? { summary } : {}),
    // A missing tool, collection or input is "not run", never a failure for the model to fix.
    ...(result.notRun ? { repair: "never" as const } : {}),
    ...(result.preset === "junoser" && result.status === "fail" ? { note: JUNOSER_NOTE } : {}),
  };
}

const presetRunner = (network: NetworkToolContext = {}): NamedCheckRunner => async (name, spec, context) => {
  const { runNetworkCheck } = await import("../network/checks");
  return fromNetworkResult(await runNetworkCheck(name, { ...spec, timeout: spec.timeout ?? Math.ceil(context.timeoutMs / 1000) },
    { ...network, root: context.cwd, ...(context.signal ? { signal: context.signal } : {}) }));
};

export class VerifierRegistry {
  private readonly verifiers = new Map<CheckName, Verifier>();
  /** A device (lab) check can run here, after a person answers its box: the AI may ask for one. */
  private labAsks = false;

  register(verifier: Verifier): void {
    if (this.verifiers.has(verifier.name)) throw new Error(`Verifier already registered: ${verifier.name}`);
    this.verifiers.set(verifier.name, { ...verifier, scope: verifier.scope ? structuredClone(verifier.scope) : undefined });
  }

  /** Every registered check, built-in ones first. */
  names(): CheckName[] { return [...this.verifiers.keys()]; }

  /** Checks the AI may run through casper_check: never built-ins with no command, and device (lab) checks only where
   * a person can be asked (each one shows its box first; only the person's answer starts it). */
  modelNames(): CheckName[] {
    return [...this.verifiers.values()].filter((verifier) => (verifier.kind !== "lab" || this.labAsks) && verifier.runnable !== false)
      .map((verifier) => verifier.name);
  }

  has(name: string): boolean { return this.verifiers.has(name); }

  /** True when a device (lab) check can run here after a person answers its box. */
  canAskForLab(): boolean { return this.labAsks; }

  kind(name: CheckName): Verifier["kind"] { return this.verifiers.get(name)?.kind; }

  command(name: CheckName): string | undefined { return this.verifiers.get(name)?.command; }

  scope(name: CheckName): VerificationScope | undefined {
    const scope = this.verifiers.get(name)?.scope;
    return scope ? structuredClone(scope) : undefined;
  }

  async run(
    names: readonly CheckName[],
    options: { signal?: AbortSignal; onResult?: (result: VerificationResult) => void; timeoutMs?: number } = {},
  ): Promise<VerificationResult[]> {
    const selected = [...new Set(names)].map((name) => {
      const verifier = this.verifiers.get(name);
      if (!verifier) throw new Error(`Unknown verifier: ${name}`);
      return verifier;
    });
    const results: VerificationResult[] = [];
    for (const verifier of selected) {
      const result = await verifier.run(options.signal, options.timeoutMs ? { timeoutMs: options.timeoutMs } : undefined);
      results.push(result);
      options.onResult?.(result);
      if (options.signal?.aborted) break;
    }
    return results;
  }

  static forProject(model: ProjectModel, timeoutMs = 120_000, onCleanupFailure?: () => void, options: ForProjectOptions = {}): VerifierRegistry {
    const registry = new VerifierRegistry();
    registry.labAsks = Boolean(options.runLab);
    const cwd = model.project.root;
    let cleanupFailed = false;
    const blocked = (name: CheckName): VerificationResult => ({ name, cwd, status: "fail", ...nothing, reason: "Owned process cleanup is unconfirmed; no further checks started" });
    const limit = (given?: number) => given ? Math.min(Math.max(given, timeoutMs), 3_600_000) : timeoutMs;
    const onCleanup = () => { cleanupFailed = true; onCleanupFailure?.(); };
    const wrap = options.wrap ? { wrap: options.wrap } : {};
    for (const name of CHECK_NAMES) {
      // Freeze the command contract for this task, including throughout repairs.
      const command = model.commands[name];
      registry.register({
        name,
        scope: model.verificationScopes?.[name],
        ...(command?.trim() ? { command } : { runnable: false as const }),
        run: async (signal, runOptions) => cleanupFailed ? blocked(name)
          : command?.trim()
          ? runCommandCheck({ name, command, cwd, timeoutMs: limit(runOptions?.timeoutMs), signal, onCleanupFailure: onCleanup, ...wrap })
          : { name, cwd, status: "skip", ...nothing, reason: "No command configured or detected" },
      });
    }
    const runPreset = options.runPreset ?? presetRunner(options.network);
    for (const [name, spec] of Object.entries(model.namedChecks ?? {})) {
      if (isBuiltinCheck(name)) continue; // The parser refuses these; a named check never replaces a built-in one.
      const frozen = structuredClone(spec);
      const kind = frozen.kind === "offline" ? undefined : frozen.kind;
      registry.register({
        name,
        ...(kind ? { kind } : {}),
        ...(frozen.run ? { command: frozen.run } : {}),
        run: async (signal, runOptions) => {
          if (cleanupFailed) return blocked(name);
          if (frozen.kind === "lab") {
            // Only a registry that can ask a person has a lab runner; nothing reaches a device without their answer.
            if (!options.runLab) return { name, cwd, status: "skip", ...nothing, kind: "lab", reason: labOnlyByYou(name), repair: "never" };
            return options.runLab(name, frozen, { cwd, timeoutMs: frozen.timeout ? frozen.timeout * 1000 : 600_000, ...(signal ? { signal } : {}) });
          }
          const checkTimeout = runOptions?.timeoutMs ? limit(runOptions.timeoutMs) : frozen.timeout ? frozen.timeout * 1000 : timeoutMs;
          if (frozen.run) return runCommandCheck({ name, command: frozen.run, cwd, timeoutMs: checkTimeout, signal, onCleanupFailure: onCleanup, ...wrap });
          return runPreset(name, frozen, { cwd, timeoutMs: checkTimeout, ...(signal ? { signal } : {}) });
        },
      });
    }
    // The SQL migrations check Casper found in the project (unless the project named its own `migrations`).
    const migrations = detectedMigrations(model);
    if (migrations) {
      const plan = structuredClone(migrations);
      // Ones Casper can't apply only skip: /verify migrations says why, the AI isn't offered them.
      registry.register({ name: MIGRATIONS_CHECK, scope: migrationsScope(plan), ...(migrationsRunnable(plan) ? {} : { runnable: false as const }),
        run: async (signal) => cleanupFailed ? blocked(MIGRATIONS_CHECK) : runDetectedMigrations(cwd, plan, signal) });
    }
    // The project's own Playwright tests (unless it named its own `e2e`). Not installed: it only skips and says why.
    const e2e = detectedE2e(model);
    if (e2e) {
      const { command, installed } = e2e;
      registry.register({ name: E2E_CHECK, command, ...(installed ? {} : { runnable: false as const }),
        run: async (signal, runOptions) => cleanupFailed ? blocked(E2E_CHECK)
          : !installed ? { name: E2E_CHECK, cwd, status: "skip", ...nothing, reason: e2eNotInstalled(model.packageManager), repair: "never" }
          : e2eResult(await runCommandCheck({ name: E2E_CHECK, command, cwd, timeoutMs: limit(runOptions?.timeoutMs), signal, onCleanupFailure: onCleanup, ...wrap })) });
    }
    return registry;
  }
}

/** The names /verify runs when none are given: the built-in checks and every named check but lab ones. */
export function defaultVerifyNames(model: Pick<ProjectModel, "namedChecks" | "migrations" | "e2e">): CheckName[] {
  const migrations = detectedMigrations(model);
  return [...CHECK_NAMES, ...modelNamedChecks(model.namedChecks), ...(migrations && migrationsRunnable(migrations) ? [MIGRATIONS_CHECK] : []),
    ...(detectedE2e(model)?.installed ? [E2E_CHECK] : [])];
}
