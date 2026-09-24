import { blank, description, linkLags, normalizeMac, speed, untilPager } from "../common";
import type { Interface, ParseResult } from "../model";

const PHYSICAL = /^Physical interface: ([^,\s]+), (Enabled|Administratively down), Physical link is (Up|Down)/;
const LOGICAL = /^\s+Logical interface (\S+)/;

export function parseJunos(text: string): ParseResult {
  const { lines, truncated } = untilPager(text);
  const interfaces: Interface[] = [];
  let physical: Interface | undefined;
  let current: Interface | undefined;
  let bundled = false;
  let flagsSeen = false;
  let blockStart = 0;
  const members = new Map<string, string[]>();
  const close = () => {
    if (current && !bundled) interfaces.push(current);
    current = undefined;
    bundled = false;
  };
  for (const line of lines) {
    let match: RegExpExecArray | null;
    if ((match = PHYSICAL.exec(line))) {
      close();
      blockStart = interfaces.length;
      physical = blank(match[1]!);
      physical.adminUp = match[2] === "Enabled";
      physical.operUp = match[3] === "Up";
      current = physical;
      continue;
    }
    if ((match = LOGICAL.exec(line)) && physical) {
      close();
      current = blank(match[1]!);
      current.adminUp = physical.adminUp;
      flagsSeen = false;
      continue;
    }
    if (!current) continue;
    const logical = current !== physical;
    const text = description(line);
    if (text !== undefined) { current.description = text; continue; }
    if (logical && !flagsSeen && (match = /^\s+Flags: (.*)$/.exec(line))) {
      flagsSeen = true;
      const flags = match[1]!.split(/\s+/);
      current.operUp = flags.includes("Up");
      if (flags.includes("Disabled")) current.adminUp = false;
    }
    if (!logical && /Link-level type:/.test(line)) {
      if ((match = /\bMTU: (\d+)/.exec(line))) current.mtu = Number(match[1]);
      if ((match = /\bSpeed: (\d+)([mg])bps/i.exec(line))) current.speedMbps = speed(match[1]!, match[2]!);
    }
    if (!logical && (match = /Current address: ([0-9a-f:]+)/i.exec(line))) current.mac = normalizeMac(match[1]!);
    if (logical && (match = /Protocol inet, MTU: (\d+)/.exec(line))) current.mtu = Number(match[1]);
    if (logical && (match = /Protocol aenet, AE bundle: ([^.\s,]+)/.exec(line)) && physical) {
      bundled = true;
      const list = members.get(match[1]!) ?? [];
      list.push(physical.name);
      members.set(match[1]!, list);
    }
    if (logical && (match = /Local: (\d+\.\d+\.\d+\.\d+)/.exec(line))) {
      const prefix = /Destination: [\d.]+\/(\d+)/.exec(line)?.[1] ?? "32";
      current.ipv4.push(`${match[1]}/${prefix}`);
    }
  }
  if (truncated) {
    // The cut block is the whole physical interface, including units already closed.
    current = undefined;
    interfaces.splice(blockStart);
    if (physical) for (const list of members.values()) if (list.at(-1) === physical.name) list.pop();
  }
  close();
  for (const [lag, names] of members) {
    const entry = interfaces.find((candidate) => candidate.name === lag);
    if (entry) entry.lagMembers.push(...names);
  }
  linkLags(interfaces);
  return { interfaces, truncated };
}
