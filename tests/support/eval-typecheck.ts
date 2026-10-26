import { runVerification } from "../../evals/runner";
import { CHILD_KILL_MS } from "./limits";

/** Exercise the candidate's public script through the grader's async, owned-process path. Its guard is the one for a
 * real child (tests/support/limits.ts): tsc on the candidate takes 3-6 s on a Windows runner and has needed over 20 s on
 * a slow one. Tests that call it keep their limit above the guard (childTestLimit), so cleanup follows a reaped child. */
export async function candidateTypecheck(workdir: string, homeDir: string, repoRoot: string) {
  const result = await runVerification([{ name: "candidate typecheck", argv: [process.execPath, "run", "typecheck"] }], {
    workdir, homeDir, repoRoot, timeoutMs: CHILD_KILL_MS,
  });
  return result.checks[0]!;
}
