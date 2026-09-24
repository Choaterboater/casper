import { findMac } from "./find";
import { loadInventory } from "./inventory";
import { InvalidMacError, normalizeMac } from "./mac";

export interface IO {
  out(text: string): void;
  err(text: string): void;
}

const USAGE = "usage: macfind --data <dir> [--json] <mac>\n";

export async function main(argv: readonly string[], io: IO): Promise<number> {
  let data: string | undefined;
  let json = false;
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === "--json") json = true;
    else if (argument === "--data") data = argv[++index];
    else if (argument.startsWith("-")) { io.err(`macfind: unknown option ${argument}\n${USAGE}`); return 64; }
    else rest.push(argument);
  }
  if (!data || rest.length !== 1) { io.err(`macfind: expected --data <dir> and one MAC\n${USAGE}`); return 64; }
  let location;
  try { location = findMac(await loadInventory(data), rest[0]!); }
  catch (error) {
    if (error instanceof InvalidMacError) { io.err(`macfind: ${error.message}\n${USAGE}`); return 64; }
    throw error;
  }
  if (json) io.out(`${JSON.stringify(location)}\n`);
  else if (location) io.out(`${location.mac} is on ${location.device} ${location.port} (vlan ${location.vlan})\n`);
  else io.out(`${normalizeMac(rest[0]!)} not found on any edge port\n`);
  return location ? 0 : 1;
}
