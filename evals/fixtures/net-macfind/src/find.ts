import type { DeviceData } from "./inventory";
import { normalizeMac } from "./mac";

export interface Location {
  readonly mac: string;
  readonly device: string;
  readonly port: string;
  readonly vlan: string;
}

/** The edge port where `mac` was learned, or null. Throws InvalidMacError for a malformed MAC. */
export function findMac(devices: readonly DeviceData[], mac: string): Location | null {
  const wanted = normalizeMac(mac);
  const names = new Set(devices.map((device) => device.device));
  for (const device of devices) {
    const uplinks = new Set<string>();
    for (const neighbor of device.lldp) {
      if (neighbor.systemName === device.device || !names.has(neighbor.systemName)) continue;
      uplinks.add(neighbor.localPort);
      if (neighbor.parentPort) uplinks.add(neighbor.parentPort);
      for (const [lag, members] of Object.entries(device.lags)) if (members.includes(neighbor.localPort)) uplinks.add(lag);
    }
    const entry = device.macTable.find((candidate) => candidate.mac === wanted && !uplinks.has(candidate.port));
    if (entry) return { mac: wanted, device: device.device, port: entry.port, vlan: entry.vlan };
  }
  return null;
}
