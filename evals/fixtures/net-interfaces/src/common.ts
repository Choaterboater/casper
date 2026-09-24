import type { Interface } from "./model";

const PAGER = /--\s*more\s*--|---\(more/i;

/** Lines before the first pager prompt, and whether one was seen. */
export function untilPager(text: string): { lines: string[]; truncated: boolean } {
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex((line) => PAGER.test(line));
  return index < 0 ? { lines, truncated: false } : { lines: lines.slice(0, index), truncated: true };
}

/** `aabb.ccdd.eeff`, `AA-BB-…` or `aa:bb:…` → `aa:bb:cc:dd:ee:ff`; null when it is not a MAC. */
export function normalizeMac(text: string): string | null {
  const hex = text.replace(/[.:-]/g, "").toLowerCase();
  if (!/^[0-9a-f]{12}$/.test(hex)) return null;
  return hex.match(/../g)!.join(":");
}

export function parentOf(name: string): string | null {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : null;
}

export function blank(name: string): Interface {
  return { name, adminUp: false, operUp: false, description: null, mac: null, mtu: null, speedMbps: null, ipv4: [], parent: parentOf(name), lagMembers: [], lag: null };
}

export function description(line: string): string | null | undefined {
  const match = /^\s*Description\s*:\s*(.*)$/.exec(line);
  if (!match) return undefined;
  return match[1]!.trim() || null;
}

export function speed(value: string, unit: string): number | null {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return /^g/i.test(unit) ? number * 1000 : number;
}

/** Expand abbreviated member names against the transcript and set each member's `lag`. */
export function linkLags(interfaces: Interface[]): void {
  const split = (name: string) => /^([A-Za-z-]*)(.*)$/.exec(name)!;
  for (const lag of interfaces) {
    lag.lagMembers = lag.lagMembers.map((member) => {
      if (interfaces.some((entry) => entry.name === member)) return member;
      const [, type, number] = split(member);
      const match = interfaces.find((entry) => {
        const [, fullType, fullNumber] = split(entry.name);
        return !!type && fullNumber === number && fullType!.toLowerCase().startsWith(type!.toLowerCase());
      });
      return match ? match.name : member;
    });
    for (const member of lag.lagMembers) {
      const entry = interfaces.find((candidate) => candidate.name === member);
      if (entry) entry.lag = lag.name;
    }
  }
}
