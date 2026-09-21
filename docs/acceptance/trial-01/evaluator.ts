import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
const trial = "/tmp/casper-acceptance-sgTCoi";
const baseline = path.join(trial, "baseline");
const candidate = path.resolve(process.argv[2] ?? baseline);
const fixture = await realpath(await mkdtemp(path.join(trial, "fixtures/inspection-")));
async function run(command: string[], cwd: string, extra: Record<string, string> = {}) {
  const child = Bun.spawn(command, { cwd, env: { PATH: process.env.PATH!, HOME: path.join(trial, "baseline-home"), LANG: "en_US.UTF-8", PI_OFFLINE: "1", PI_TELEMETRY: "0", ...extra }, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    assert.equal(exit, 0, stderr);
    return stdout;
  } finally { clearTimeout(timer); }
}
const git = (cwd: string, ...args: string[]) => run(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], cwd);
let sample = 0;
async function inspect(source: string, cwd: string) {
  const trace = path.join(fixture, `trace-${sample++}.jsonl`);
  const value = JSON.parse(await run([process.execPath, "-e", `const {inspectProject}=await import(${JSON.stringify(path.join(source,"src/project/inspect.ts"))});console.log(JSON.stringify(await inspectProject(process.argv[1])));`, cwd], cwd, { GIT_TRACE2_EVENT: trace }));
  const traceLines = (await readFile(trace, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  return { value, gitStarts: traceLines.filter(event => event.event === "start").length };
}
const report: { cases: Array<{ name: string; baselineGitStarts: number; candidateGitStarts: number }>; cli: boolean; timing?: unknown } = { cases: [], cli: false };
try {
  const repo = path.join(fixture, "repo space café");
  const plain = path.join(fixture, "plain space café");
  const unborn = path.join(fixture, "unborn");
  const worktree = path.join(fixture, "linked worktree");
  await Promise.all([mkdir(repo), mkdir(plain), mkdir(unborn)]);
  await git(repo, "init", "-b", "main");
  await git(unborn, "init", "-b", "new-branch");
  await writeFile(path.join(repo, "file.txt"), "fixture\n");
  await git(repo, "add", "file.txt");
  await git(repo, "-c", "user.name=Casper Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture");
  const nested = path.join(repo, "nested", "directory");
  await mkdir(nested, { recursive: true });
  async function check(name: string, cwd: string, root: string, branch: string | null, isGit: boolean) {
    const expected = { cwd, root, name: path.basename(root), gitBranch: branch, isGit };
    const before = await inspect(baseline, cwd);
    const after = await inspect(candidate, cwd);
    assert.deepEqual(before.value, expected, `${name}: frozen baseline`);
    assert.deepEqual(after.value, expected, `${name}: candidate`);
    report.cases.push({ name, baselineGitStarts: before.gitStarts, candidateGitStarts: after.gitStarts });
  }
  await check("committed", repo, repo, "main", true);
  await check("nested", nested, repo, "main", true);
  await check("unborn", unborn, unborn, "new-branch", true);
  await check("non-git", plain, plain, null, false);
  await git(repo, "checkout", "--detach", "HEAD");
  await check("detached", repo, repo, null, true);
  await git(repo, "checkout", "main");
  await git(repo, "worktree", "add", "-b", "linked", worktree);
  await check("worktree", worktree, worktree, "linked", true);
  const cli = await run([process.execPath, path.join(candidate, "src/cli.ts"), "/project"], nested);
  assert.ok(cli.includes("repo space café"));
  assert.match(cli, /branch\s+main/);
  report.cli = true;
  if (candidate !== baseline) {
    assert.ok(report.cases.find(c => c.name === "committed")!.candidateGitStarts < report.cases.find(c => c.name === "committed")!.baselineGitStarts, "ordinary Git subprocess count must decrease");
    const values: Record<string, number[]> = { before: [], after: [] };
    // Identical fixture; two warmups then five ABBA blocks of fresh processes.
    for (const source of [baseline, candidate]) for (let i=0;i<2;i++) await inspect(source, repo);
    for (let i=0;i<5;i++) for (const [label, source] of [["before",baseline],["after",candidate],["after",candidate],["before",baseline]]) {
      const start = performance.now();
      await inspect(source!, repo);
      values[label!]!.push(performance.now() - start);
    }
    report.timing = Object.fromEntries(Object.entries(values).map(([name, samples]) => {
      const sorted = [...samples].sort((a,b)=>a-b);
      return [name,{medianMs:(sorted[4]!+sorted[5]!)/2,minMs:sorted[0],maxMs:sorted.at(-1),samplesMs:samples}];
    }));
  }
  console.log(JSON.stringify({status:"pass",...report},null,2));
} finally { await rm(fixture,{recursive:true,force:true}); }
