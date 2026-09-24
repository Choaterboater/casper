import { blank, description, linkLags, normalizeMac, speed, untilPager } from "../common";
import type { Interface, ParseResult } from "../model";

const HEAD = /^(\S+) is (up|down|administratively down), line protocol is (up|down)/;

export function parseIosXe(text: string): ParseResult {
  const { lines, truncated } = untilPager(text);
  const interfaces: Interface[] = [];
  let current: Interface | undefined;
  for (const line of lines) {
    const head = HEAD.exec(line);
    if (head) {
      current = blank(head[1]!);
      current.adminUp = head[2] !== "administratively down";
      current.operUp = head[3] === "up";
      interfaces.push(current);
      continue;
    }
    if (!current) continue;
    const text = description(line);
    if (text !== undefined) { current.description = text; continue; }
    let match: RegExpExecArray | null;
    if ((match = /^\s*Hardware is .*\baddress is ([0-9a-f.]+)/i.exec(line))) current.mac = normalizeMac(match[1]!);
    if ((match = /Internet address is (\d+\.\d+\.\d+\.\d+\/\d+)/.exec(line))) current.ipv4.push(match[1]!);
    if ((match = /\bMTU (\d+) bytes/.exec(line))) current.mtu = Number(match[1]);
    if ((match = /duplex, (\d+)([MG])b\/s/i.exec(line))) current.speedMbps = speed(match[1]!, match[2]!);
    if ((match = /Members in this channel:\s*(.*)$/.exec(line))) current.lagMembers = match[1]!.trim().split(/\s+/).filter(Boolean);
  }
  if (truncated) interfaces.pop();
  linkLags(interfaces);
  return { interfaces, truncated };
}
