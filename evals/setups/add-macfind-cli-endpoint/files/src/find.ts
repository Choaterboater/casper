import type { DeviceData } from "./inventory";

export interface Location {
  readonly mac: string;
  readonly device: string;
  readonly port: string;
  readonly vlan: string;
}

/** Where `mac` was learned, or null. */
export function findMac(devices: readonly DeviceData[], mac: string): Location | null {
  for (const device of devices) {
    const entry = device.macTable.find((candidate) => candidate.mac === mac);
    if (entry) return { mac, device: device.device, port: entry.port, vlan: entry.vlan };
  }
  return null;
}
