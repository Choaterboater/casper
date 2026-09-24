import { expect, test } from "bun:test";
import { formatPlan } from "../src/format";

test("prints creates, updates, NetBox-only devices and a dry-run summary", () => {
  expect(formatPlan({
    create: [{ name: "edge-9", serial: "S9", site: "hq", role: "access", primaryIp4: null }],
    update: [{ name: "core-1", id: 4, changes: { serial: { from: "OLD", to: "NEW" }, primaryIp4: { from: null, to: "192.0.2.1/24" } } }],
    unchanged: ["dist-1"],
    onlyInNetbox: ["legacy-3"],
  })).toBe([
    "+ create edge-9 (site hq, role access)",
    "~ update core-1: serial OLD -> NEW; primaryIp4 - -> 192.0.2.1/24",
    "? only in NetBox: legacy-3",
    "Plan: 1 to create, 1 to update, 1 unchanged, 1 only in NetBox. Dry run: no changes made.",
    "",
  ].join("\n"));
});
