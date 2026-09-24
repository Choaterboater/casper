export interface Target {
  readonly target: string;
  readonly host: string | null;
  readonly port: number | null;
}

export interface Options {
  readonly targets: readonly Target[];
  readonly timeoutMs: number;
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
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === "--timeout") {
      timeoutMs = Number(argv[++index]);
    } else if (argument.startsWith("-")) throw new UsageError(`unknown option ${argument}`);
    else targets.push(parseTarget(argument));
  }
  if (!targets.length) throw new UsageError("at least one host:port target is required");
  return { targets, timeoutMs };
}
