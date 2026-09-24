import { radiusTest, type RadiusResult } from "./client";

export interface IO {
  out(text: string): void;
  err(text: string): void;
}

const USAGE = "usage: radtest --host <host> [--port 1812] --secret <secret> --user <name> --password <password> [--timeout ms] [--retries n] [--json]\n";
const LABEL: Record<RadiusResult["status"], string> = {
  accept: "Access-Accept", reject: "Access-Reject", challenge: "Access-Challenge", timeout: "No reply (timeout)", "bad-response": "Invalid reply (check the shared secret)",
};
const EXIT: Record<RadiusResult["status"], number> = { accept: 0, reject: 1, challenge: 1, timeout: 2, "bad-response": 2 };

export async function main(argv: readonly string[], io: IO): Promise<number> {
  const values: Record<string, string> = {};
  let json = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === "--json") { json = true; continue; }
    const name = /^--(host|port|secret|user|password|timeout|retries)$/.exec(argument)?.[1];
    const value = argv[index + 1];
    if (!name || value === undefined) { io.err(`radtest: ${name ? `${argument} needs a value` : `unexpected argument ${argument}`}\n${USAGE}`); return 64; }
    values[name] = value;
    index++;
  }
  for (const required of ["host", "secret", "user", "password"]) {
    if (!values[required]) { io.err(`radtest: --${required} is required\n${USAGE}`); return 64; }
  }
  const integer = (name: string, fallback: number, minimum: number, maximum: number) => {
    if (values[name] === undefined) return fallback;
    const number = Number(values[name]);
    return Number.isInteger(number) && number >= minimum && number <= maximum ? number : undefined;
  };
  const port = integer("port", 1812, 1, 65535);
  const timeoutMs = integer("timeout", 2000, 1, 60_000);
  const retries = integer("retries", 2, 0, 10);
  if (port === undefined || timeoutMs === undefined || retries === undefined) { io.err(`radtest: --port, --timeout and --retries must be integers in range\n${USAGE}`); return 64; }
  const result = await radiusTest({ host: values.host!, port, secret: values.secret!, username: values.user!, password: values.password!, timeoutMs, retries });
  if (json) io.out(`${JSON.stringify(result)}\n`);
  else {
    const lines = [`${LABEL[result.status]} from ${values.host}:${port} (attempts ${result.attempts})`];
    for (const message of result.replyMessages) lines.push(`  Reply-Message: ${message}`);
    if (result.arubaUserRole !== null) lines.push(`  Aruba-User-Role: ${result.arubaUserRole}`);
    for (const pair of result.ciscoAvPairs) lines.push(`  Cisco-AVPair: ${pair}`);
    io.out(`${lines.join("\n")}\n`);
  }
  return EXIT[result.status];
}
