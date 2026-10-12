/**
 * Run a fixture program (git, a shell line) and wait for it on the event loop.
 *
 * Not spawnSync or execFileSync: under `bun test --parallel` (Bun 1.4) a worker now and then never sees a sync
 * child's exit. CI stall dumps show it: one test worker at full CPU with a zombie git, mkfifo, bwrap or cat child
 * it never reaps, the file it was given "still running" for the whole run, until the stall guard ends the job. A
 * sync call's own `timeout` does not help (packs-git saw `spawnSync git ETIMEDOUT` for `git config`). An async
 * child is reaped by the event loop, and one that really hangs is killed after `timeoutMs` and named in the failure.
 */
export interface RunResult { status: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean }

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Text written to the program's stdin; without it stdin is closed. */
  input?: string;
  /** Kill the program after this long; the default keeps it below the 30 s test limit. */
  timeoutMs?: number;
}

export async function run(argv: string[], options: RunOptions = {}): Promise<RunResult> {
  const env = options.env && Object.fromEntries(Object.entries(options.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const child = Bun.spawn(argv, {
    cwd: options.cwd, env, stdin: options.input === undefined ? "ignore" : new Response(options.input), stdout: "pipe", stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.timeoutMs ?? 20_000);
  try {
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    await child.exited;
    return { status: child.exitCode, signal: child.signalCode ?? null, stdout, stderr, timedOut };
  } finally { clearTimeout(timer); }
}

/** `run`, failing with the command, its output and why it stopped when it does not exit 0; returns trimmed stdout. */
export async function runOk(argv: string[], options: RunOptions = {}): Promise<string> {
  const result = await run(argv, options);
  if (result.status === 0) return result.stdout.trim();
  const why = result.timedOut ? `no answer in ${(options.timeoutMs ?? 20_000) / 1000} s` : result.signal ? `stopped by ${result.signal}` : `exit ${result.status}`;
  throw new Error(`${argv.join(" ")}: ${[result.stderr.trim(), why].filter(Boolean).join(" · ")}`);
}
