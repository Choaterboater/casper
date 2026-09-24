import { blank, description, linkLags, normalizeMac, speed, untilPager } from "../common";
import type { Interface, ParseResult } from "../model";

const HEAD = /^(?:Interface|Aggregate) (\S+) is (up|down)\b/;

export function parseAosCx(text: string): ParseResult {
  const { lines, truncated } = untilPager(text);
  const interfaces: Interface[] = [];
  let current: Interface | undefined;
  for (const line of lines) {
    let match: RegExpExecArray | null;
    if ((match = HEAD.exec(line))) {
      current = blank(match[1]!);
      current.operUp = match[2] === "up";
      interfaces.push(current);
      continue;
    }
    if (!current) continue;
    const text = description(line);
    if (text !== undefined) { current.description = text; continue; }
    if ((match = /^\s*Admin state is (up|down)/.exec(line))) current.adminUp = match[1] === "up";
    if ((match = /MAC Address\s*:\s*([0-9a-f:]+)/i.exec(line))) current.mac = normalizeMac(match[1]!);
    if ((match = /^\s*MTU (\d+)/.exec(line))) current.mtu = Number(match[1]);
    if ((match = /^\s*Speed (\d+) ([MG])b\/s/.exec(line))) current.speedMbps = speed(match[1]!, match[2]!);
    if ((match = /^\s*IPv4 address (\d+\.\d+\.\d+\.\d+\/\d+)/.exec(line))) current.ipv4.push(match[1]!);
    if ((match = /^\s*Aggregated-interfaces\s*:\s*(.*)$/.exec(line))) current.lagMembers = match[1]!.trim().split(/\s+/).filter(Boolean);
  }
  if (truncated) interfaces.pop();
  linkLags(interfaces);
  return { interfaces, truncated };
}
