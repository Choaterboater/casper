import { runVerification } from "../../evals/runner";

/** Exercise the candidate's public script through the grader's async, owned-process path.
 * Keep its guard below the test's existing 30 s limit so cleanup follows a reaped child. */
export async function candidateTypecheck(workdir: string, homeDir: string, repoRoot: string) {
  const result = await runVerification([{ name: "candidate typecheck", argv: [process.execPath, "run", "typecheck"] }], {
    workdir, homeDir, repoRoot, timeoutMs: 20_000,
  });
  return result.checks[0]!;
}
