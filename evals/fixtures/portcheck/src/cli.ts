import { parseArgs, UsageError, type Target } from "./args";
import { probe, type ProbeResult } from "./probe";

export interface IO {
  out(text: string): void;
  err(text: string): void;
}

export interface Row {
  readonly target: string;
  readonly host: string | null;
  readonly port: number | null;
  readonly status: ProbeResult["status"] | "invalid";
  readonly ms: number | null;
  readonly tls?: ProbeResult["tls"];
}

async function check(target: Target, options: { timeoutMs: number; tls: boolean }): Promise<Row> {
  if (target.host === null || target.port === null) return { ...target, status: "invalid", ms: null };
  const result = await probe(target.host, target.port, options);
  return { ...target, status: result.status, ms: result.ms, ...(result.tls ? { tls: result.tls } : {}) };
}

function line(row: Row): string {
  const parts = [row.target, row.status];
  if (row.ms !== null && row.status === "open") parts.push(`${row.ms}ms`);
  if (row.tls) parts.push(`expires ${row.tls.expires.slice(0, 10)} (${row.tls.daysLeft} days)`);
  return parts.join(" ");
}

export async function main(argv: readonly string[], io: IO): Promise<number> {
  let options;
  try { options = parseArgs(argv); }
  catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.err(`portcheck: ${error.message}\nusage: portcheck [--json] [--tls] [--timeout ms] host:port...\n`);
    return 64;
  }
  const rows = await Promise.all(options.targets.map((target) => check(target, options)));
  if (options.json) io.out(`${JSON.stringify(rows)}\n`);
  else for (const row of rows) io.out(`${line(row)}\n`);
  return rows.every((row) => row.status === "open") ? 0 : 1;
}
