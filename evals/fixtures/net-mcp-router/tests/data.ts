import type { Inventory } from "../src/inventory";

export const inventory: Inventory = new Map([
  ["lab-sw1", { hostname: "lab-sw1", model: "6300M", firmware: "FL.10.13.1000", interfaces: [
    { name: "1/1/1", adminUp: true, operUp: true, description: "ap-lobby", speedMbps: 1000 },
    { name: "1/1/2", adminUp: false, operUp: false, description: null, speedMbps: null },
  ] }],
]);
