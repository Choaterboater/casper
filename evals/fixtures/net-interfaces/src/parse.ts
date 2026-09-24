import type { ParseResult, Vendor } from "./model";
import { parseAosCx } from "./vendors/aoscx";
import { parseIosXe } from "./vendors/iosxe";
import { parseJunos } from "./vendors/junos";

const PARSERS: Record<Vendor, (text: string) => ParseResult> = { iosxe: parseIosXe, junos: parseJunos, aoscx: parseAosCx };

export function parseInterfaces(vendor: Vendor, text: string): ParseResult {
  const parser = PARSERS[vendor];
  if (!parser) throw new Error(`Unsupported vendor: ${vendor}`);
  return parser(text);
}
