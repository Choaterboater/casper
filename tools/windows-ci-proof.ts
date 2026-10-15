/** Read-only evidence check: only a full Windows run at this exact commit, on its first attempt, counts. */
interface Run { path: string; event: string; status: string; conclusion: string | null; head_sha: string; run_attempt: number }
interface Job { name: string; status: string; conclusion: string | null }

export function windowsProofProblems(run: Run, jobs: readonly Job[], expectedSha: string): string[] {
  const problems: string[] = [];
  if (run.path !== ".github/workflows/windows-preview.yml") problems.push("not the Windows preview workflow");
  if (!["push", "schedule", "workflow_dispatch"].includes(run.event)) problems.push("not a guaranteed full-suite event");
  if (run.head_sha !== expectedSha) problems.push("commit does not match");
  if (run.run_attempt !== 1) problems.push("run was rerun");
  if (run.status !== "completed" || run.conclusion !== "success") problems.push("workflow is not completed green");
  const required = ["changes", "standalone", "terminal", ...Array.from({ length: 6 }, (_, index) => `suite (${index + 1})`)];
  for (const name of required) {
    const matching = jobs.filter(job => job.name === name);
    if (matching.length !== 1 || matching[0]!.status !== "completed" || matching[0]!.conclusion !== "success") problems.push(`${name} did not finish green exactly once`);
  }
  if (jobs.some(job => job.status !== "completed" || job.conclusion !== "success")) problems.push("a job is skipped, incomplete or failed");
  return problems;
}

if (import.meta.main) {
  const [id, sha] = process.argv.slice(2);
  if (!/^\d+$/.test(id ?? "") || !/^[0-9a-f]{40}$/.test(sha ?? "")) throw new Error("usage: bun tools/windows-ci-proof.ts <run-id> <commit-sha>");
  const json = async (endpoint: string) => {
    const child = Bun.spawn(["gh", "api", endpoint], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 60_000 });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (exit !== 0) throw new Error(`GitHub evidence lookup failed: ${stderr.trim()}`);
    return JSON.parse(stdout);
  };
  const root = `repos/{owner}/{repo}/actions/runs/${id}`;
  const run: Run = await json(root);
  const page: { jobs: Job[]; total_count: number } = await json(`${root}/jobs?per_page=100`);
  const problems = windowsProofProblems(run, page.jobs, sha!);
  if (page.jobs.length !== page.total_count) problems.push("job list is incomplete");
  console.log(JSON.stringify({ run: id, sha: run.head_sha, attempt: run.run_attempt, proven: !problems.length, problems }, null, 2));
  process.exitCode = problems.length ? 1 : 0;
}
