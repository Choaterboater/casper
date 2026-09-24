import { parseArgs, UsageError, type Target } from "./args";
import { probe, type ProbeResult } from "./probe";

export interface IO {
  out(text: string): void;
  err(text: string): void;
}

export interface Row {
  readonly target: string;
  readonly status: ProbeResult["status"] | "invalid";
  readonly ms: number | null;
}

async function check(target: Target, options: { timeoutMs: number }): Promise<Row> {
  if (target.host === null || target.port === null) return { target: target.target, status: "invalid", ms: null };
  const result = await probe(target.host, target.port, options);
  return { target: target.target, status: result.status, ms: result.ms };
}

function line(row: Row): string {
  return row.ms !== null && row.status === "open" ? `${row.target} ${row.status} ${row.ms}ms` : `${row.target} ${row.status}`;
}

export async function main(argv: readonly string[], io: IO): Promise<number> {
  let options;
  try { options = parseArgs(argv); }
  catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.err(`portcheck: ${error.message}\nusage: portcheck [--timeout ms] host:port...\n`);
    return 64;
  }
  const rows = await Promise.all(options.targets.map((target) => check(target, options)));
  for (const row of rows) io.out(`${line(row)}\n`);
  return rows.every((row) => row.status === "open") ? 0 : 1;
}
