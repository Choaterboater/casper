import { expect, test } from "bun:test";
import path from "node:path";
import { findMac } from "../src/find";
import { loadInventory } from "../src/inventory";

test("finds a MAC on its access port", async () => {
  const devices = await loadInventory(path.join(import.meta.dir, "data"));
  expect(findMac(devices, "02:00:5e:10:00:01")).toMatchObject({ device: "access-1", port: "Gi1/0/5", vlan: "10" });
});
