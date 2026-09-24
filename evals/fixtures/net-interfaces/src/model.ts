export type Vendor = "iosxe" | "junos" | "aoscx";

export interface Interface {
  name: string;
  adminUp: boolean;
  operUp: boolean;
  description: string | null;
  mac: string | null;
  mtu: number | null;
  speedMbps: number | null;
  ipv4: string[];
  parent: string | null;
  lagMembers: string[];
  lag: string | null;
}

export interface ParseResult {
  interfaces: Interface[];
  truncated: boolean;
}
