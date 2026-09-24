import { normalizeMac } from "./mac";

export type Vendor = "iosxe" | "junos" | "aoscx";

export interface MacEntry {
  readonly mac: string;
  readonly vlan: string;
  readonly port: string;
}

export interface LldpNeighbor {
  readonly localPort: string;
  /** The LAG the local port belongs to, when the table shows it (Junos "Parent Interface"). */
  readonly parentPort: string | null;
  readonly systemName: string;
}

const MAC_ROWS: Record<Vendor, RegExp> = {
  iosxe: /^\s*(\d+)\s+([0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4})\s+\S+\s+(\S+)\s*$/i,
  // Vlan name, MAC, flags, age, logical interface (unit suffix removed below).
  junos: /^\s*(\S+)\s+((?:[0-9a-f]{2}:){5}[0-9a-f]{2})\s+\S+\s+\S+\s+(\S+)/i,
  aoscx: /^\s*((?:[0-9a-f]{2}:){5}[0-9a-f]{2})\s+(\d+)\s+\S+\s+(\S+)\s*$/i,
};

/** Learned entries only; CPU/router entries are skipped. Junos logical units map to their port. */
export function parseMacTable(vendor: Vendor, text: string): MacEntry[] {
  const entries: MacEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = MAC_ROWS[vendor].exec(line);
    if (!match) continue;
    const [vlan, mac, port] = vendor === "aoscx" ? [match[2]!, match[1]!, match[3]!] : [match[1]!, match[2]!, match[3]!];
    if (/^(CPU|Router|Switch)$/i.test(port)) continue;
    entries.push({ mac: normalizeMac(mac), vlan, port: vendor === "junos" ? port.replace(/\.\d+$/, "") : port });
  }
  return entries;
}

export function parseLldp(vendor: Vendor, text: string): LldpNeighbor[] {
  const neighbors: LldpNeighbor[] = [];
  for (const line of text.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (vendor === "iosxe") {
      // Device ID, Local Intf, Hold-time, Capability, Port ID
      if (columns.length >= 5 && /^\d+$/.test(columns[2]!) && /^[A-Z][a-z]*\d/.test(columns[1]!)) neighbors.push({ localPort: columns[1]!, parentPort: null, systemName: columns[0]! });
    } else if (vendor === "junos") {
      // Local Interface, Parent Interface, Chassis Id, Port info, System Name
      if (columns.length >= 5 && /^[a-z]{2}-\d/.test(columns[0]!) && /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(columns[2]!)) neighbors.push({ localPort: columns[0]!, parentPort: columns[1] === "-" ? null : columns[1]!, systemName: columns.at(-1)! });
    } else if (columns.length >= 6 && /^\d+\/\d+\/\d+$/.test(columns[0]!) && /^\d+$/.test(columns.at(-2)!)) {
      // LOCAL-PORT, CHASSIS-ID, PORT-ID, PORT-DESC, TTL, SYS-NAME
      neighbors.push({ localPort: columns[0]!, parentPort: null, systemName: columns.at(-1)! });
    }
  }
  return neighbors;
}
