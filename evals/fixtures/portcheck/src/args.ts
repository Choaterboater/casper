export interface Target {
  readonly target: string;
  readonly host: string | null;
  readonly port: number | null;
}

export interface Options {
  readonly targets: readonly Target[];
  readonly timeoutMs: number;
  readonly json: boolean;
  readonly tls: boolean;
}

export class UsageError extends Error {}

export function parseTarget(text: string): Target {
  const match = /^([A-Za-z0-9.-]+):(\d{1,5})$/.exec(text);
  const port = match ? Number(match[2]) : NaN;
  if (!match || port < 1 || port > 65535) return { target: text, host: null, port: null };
  return { target: text, host: match[1]!, port };
}

export function parseArgs(argv: readonly string[]): Options {
  const targets: Target[] = [];
  let timeoutMs = 3000;
  let json = false;
  let tls = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === "--json") json = true;
    else if (argument === "--tls") tls = true;
    else if (argument === "--timeout") {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < 1) throw new UsageError("--timeout needs a positive number of milliseconds");
      timeoutMs = value;
    } else if (argument.startsWith("-")) throw new UsageError(`unknown option ${argument}`);
    else targets.push(parseTarget(argument));
  }
  if (!targets.length) throw new UsageError("at least one host:port target is required");
  return { targets, timeoutMs, json, tls };
}
