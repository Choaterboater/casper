import type { ProjectModel } from "../project/model";
import type { NetworkCheckResult } from "../network/spec";
import { runCommandCheck, type CommandWrap } from "./command";
import { CHECK_NAMES, type CheckName, type VerificationResult } from "./evidence";
import { isBuiltinCheck, LAB_NOT_YET, modelNamedChecks, type NamedCheckSpec } from "./named";
import type { VerificationScope } from "./scope";

export interface Verifier {
  name: CheckName;
  scope?: VerificationScope;
  /** Unset: an ordinary pass/fail check. See VerificationResult.kind. */
  kind?: "report" | "lab";
  /** `timeoutMs`: a longer limit the user gave an unfinished check ("Allow more time"), at most one hour. */
  run(signal?: AbortSignal, options?: { timeoutMs?: number }): Promise<VerificationResult>;
}

/** Runs one named check that uses a ready-made preset. Casper passes its network check runner; tests pass a fake. */
export type NamedCheckRunner = (name: string, spec: NamedCheckSpec, context: { cwd: string; signal?: AbortSignal; timeoutMs: number }) => Promise<VerificationResult>;

export interface ForProjectOptions {
  /** Rewrites how each command check starts (the shell sandbox). */
  wrap?: CommandWrap;
  /** Runs preset named checks; defaults to Casper's network check runner. */
  runPreset?: NamedCheckRunner;
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
  };
}

const defaultPresetRunner: NamedCheckRunner = async (name, spec, context) => {
  const { runNetworkCheck } = await import("../network/checks");
  return fromNetworkResult(await runNetworkCheck(name, { ...spec, timeout: spec.timeout ?? Math.ceil(context.timeoutMs / 1000) },
    { root: context.cwd, ...(context.signal ? { signal: context.signal } : {}) }));
};

export class VerifierRegistry {
  private readonly verifiers = new Map<CheckName, Verifier>();

  register(verifier: Verifier): void {
    if (this.verifiers.has(verifier.name)) throw new Error(`Verifier already registered: ${verifier.name}`);
    this.verifiers.set(verifier.name, { ...verifier, scope: verifier.scope ? structuredClone(verifier.scope) : undefined });
  }

  /** Every registered check, built-in ones first. */
  names(): CheckName[] { return [...this.verifiers.keys()]; }

  /** Checks the AI may run through casper_check: never lab checks. */
  modelNames(): CheckName[] { return [...this.verifiers.values()].filter((verifier) => verifier.kind !== "lab").map((verifier) => verifier.name); }

  has(name: string): boolean { return this.verifiers.has(name); }

  kind(name: CheckName): Verifier["kind"] { return this.verifiers.get(name)?.kind; }

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
        run: async (signal, runOptions) => cleanupFailed ? blocked(name)
          : command?.trim()
          ? runCommandCheck({ name, command, cwd, timeoutMs: limit(runOptions?.timeoutMs), signal, onCleanupFailure: onCleanup, ...wrap })
          : { name, cwd, status: "skip", ...nothing, reason: "No command configured or detected" },
      });
    }
    const runPreset = options.runPreset ?? defaultPresetRunner;
    for (const [name, spec] of Object.entries(model.namedChecks ?? {})) {
      if (isBuiltinCheck(name)) continue; // The parser refuses these; a named check never replaces a built-in one.
      const frozen = structuredClone(spec);
      const kind = frozen.kind === "offline" ? undefined : frozen.kind;
      registry.register({
        name,
        ...(kind ? { kind } : {}),
        run: async (signal, runOptions) => {
          if (cleanupFailed) return blocked(name);
          if (frozen.kind === "lab") return { name, cwd, status: "skip", ...nothing, kind: "lab", reason: LAB_NOT_YET, repair: "never" };
          const checkTimeout = runOptions?.timeoutMs ? limit(runOptions.timeoutMs) : frozen.timeout ? frozen.timeout * 1000 : timeoutMs;
          if (frozen.run) return runCommandCheck({ name, command: frozen.run, cwd, timeoutMs: checkTimeout, signal, onCleanupFailure: onCleanup, ...wrap });
          return runPreset(name, frozen, { cwd, timeoutMs: checkTimeout, ...(signal ? { signal } : {}) });
        },
      });
    }
    return registry;
  }
}

/** The names /verify runs when none are given: the built-in checks and every named check but lab ones. */
export function defaultVerifyNames(model: Pick<ProjectModel, "namedChecks">): CheckName[] {
  return [...CHECK_NAMES, ...modelNamedChecks(model.namedChecks)];
}
