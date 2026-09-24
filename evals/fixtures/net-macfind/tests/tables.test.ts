import { expect, test } from "bun:test";
import path from "node:path";
import { loadInventory } from "../src/inventory";

test("the sample inventory loads MAC tables and LLDP neighbors for every device", async () => {
  const devices = await loadInventory(path.join(import.meta.dir, "data"));
  expect(devices.map((device) => [device.device, device.macTable.length, device.lldp.length])).toEqual([["access-1", 2, 1], ["dist-1", 2, 1]]);
  expect(devices[0]!.macTable[0]).toEqual({ mac: "02:00:5e:10:00:01", vlan: "10", port: "Gi1/0/5" });
  expect(devices[1]!.lldp[0]).toEqual({ localPort: "1/1/1", parentPort: null, systemName: "access-1" });
});
