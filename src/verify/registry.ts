import type { ProjectCommand, ProjectModel } from "../project/model";
import { runCommandCheck } from "./command";
import { CHECK_NAMES, type VerificationResult } from "./evidence";
import type { VerificationScope } from "./scope";

export interface Verifier {
  name: ProjectCommand;
  scope?: VerificationScope;
  run(signal?: AbortSignal): Promise<VerificationResult>;
}

export class VerifierRegistry {
  private readonly verifiers = new Map<ProjectCommand, Verifier>();

  register(verifier: Verifier): void {
    if (this.verifiers.has(verifier.name)) throw new Error(`Verifier already registered: ${verifier.name}`);
    this.verifiers.set(verifier.name, { ...verifier, scope: verifier.scope ? structuredClone(verifier.scope) : undefined });
  }

  scope(name: ProjectCommand): VerificationScope | undefined {
    const scope = this.verifiers.get(name)?.scope;
    return scope ? structuredClone(scope) : undefined;
  }

  async run(
    names: readonly ProjectCommand[],
    options: { signal?: AbortSignal; onResult?: (result: VerificationResult) => void } = {},
  ): Promise<VerificationResult[]> {
    const selected = [...new Set(names)].map((name) => {
      const verifier = this.verifiers.get(name);
      if (!verifier) throw new Error(`Unknown verifier: ${name}`);
      return verifier;
    });
    const results: VerificationResult[] = [];
    for (const verifier of selected) {
      const result = await verifier.run(options.signal);
      results.push(result);
      options.onResult?.(result);
      if (options.signal?.aborted) break;
    }
    return results;
  }

  static forProject(model: ProjectModel, timeoutMs = 120_000, onCleanupFailure?: () => void): VerifierRegistry {
    const registry = new VerifierRegistry();
    const cwd = model.project.root;
    let cleanupFailed = false;
    for (const name of CHECK_NAMES) {
      // Freeze the command contract for this task, including throughout repairs.
      const command = model.commands[name];
      registry.register({
        name,
        scope: model.verificationScopes?.[name],
        run: async (signal) => cleanupFailed
          ? { name, cwd, status: "fail", exitCode: null, signal: null, stdout: "", stderr: "", truncated: false, durationMs: 0, reason: "Owned process cleanup is unconfirmed; no further checks started" }
          : command?.trim()
          ? runCommandCheck({ name, command, cwd, timeoutMs, signal, onCleanupFailure: () => { cleanupFailed = true; onCleanupFailure?.(); } })
          : { name, cwd, status: "skip", exitCode: null, signal: null, stdout: "", stderr: "", truncated: false, durationMs: 0, reason: "No command configured or detected" },
      });
    }
    return registry;
  }
}
