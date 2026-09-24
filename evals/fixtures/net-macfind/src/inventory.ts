import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseLldp, parseMacTable, type LldpNeighbor, type MacEntry, type Vendor } from "./tables";

export interface DeviceData {
  readonly device: string;
  readonly vendor: Vendor;
  readonly macTable: readonly MacEntry[];
  readonly lldp: readonly LldpNeighbor[];
  /** LAG name → member ports, from the inventory's optional `lags`. */
  readonly lags: Readonly<Record<string, readonly string[]>>;
}

export async function loadInventory(directory: string): Promise<DeviceData[]> {
  const list = JSON.parse(await readFile(path.join(directory, "inventory.json"), "utf8")) as { device: string; vendor: Vendor; mac: string; lldp: string; lags?: Record<string, string[]> }[];
  return Promise.all(list.map(async (entry) => ({
    device: entry.device,
    vendor: entry.vendor,
    macTable: parseMacTable(entry.vendor, await readFile(path.join(directory, entry.mac), "utf8")),
    lldp: parseLldp(entry.vendor, await readFile(path.join(directory, entry.lldp), "utf8")),
    lags: entry.lags ?? {},
  })));
}
