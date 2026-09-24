import { expect, test } from "bun:test";
import path from "node:path";
import { checkCompliance } from "../src/compliance";
import { diffConfigs } from "../src/diff";
import { normalizeConfig } from "../src/normalize";

const read = (name: string) => Bun.file(path.join(import.meta.dir, "configs", name)).text();

test("AOS-CX: comments, header, exit and trailing whitespace are dropped; children carry their parent", async () => {
  const lines = normalizeConfig("aoscx", await read("aoscx-before.cfg"));
  expect(lines.slice(0, 6)).toEqual([
    "hostname idf3-sw1", "ntp server 192.0.2.123 iburst", "ntp enable", "tacacs-server host 192.0.2.50 key ciphertext AQBapSynthetic1",
    "aaa group server tacacs TAC", "aaa group server tacacs TAC > server 192.0.2.50",
  ]);
  expect(lines).toContain("interface 1/1/2 > shutdown");
  expect(lines).toContain("interface 1/1/1 > no shutdown");
  expect(lines.some((line) => line.startsWith("!") || line.includes("exit") || line.startsWith("Current configuration"))).toBe(false);
});

test("AOS-CX: nested children join every parent", () => {
  expect(normalizeConfig("aoscx", "router ospf 1\n    area 0.0.0.0\n        interface vlan10\n    router-id 192.0.2.1\n")).toEqual([
    "router ospf 1", "router ospf 1 > area 0.0.0.0", "router ospf 1 > area 0.0.0.0 > interface vlan10", "router ospf 1 > router-id 192.0.2.1",
  ]);
});

test("AOS-CX: the diff ignores version comments and whitespace and keeps sub-commands under their interface", async () => {
  expect(diffConfigs("aoscx", await read("aoscx-before.cfg"), await read("aoscx-after.cfg"))).toEqual({
    added: ["interface 1/1/2 > no shutdown"],
    removed: ["snmp-server community public", "interface 1/1/2 > shutdown"],
  });
});

test("Junos: $9$ secrets are masked wherever they appear; other quoted values are kept", () => {
  expect(normalizeConfig("junos", [
    "# comment", "set system radius-server 192.0.2.60 secret \"$9$abc\"", "set snmp v3 usm local-engine user u authentication-sha authentication-key \"$9$zzz\"",
    "set system login message \"$9$ is not a secret here\"   ", "set system root-authentication encrypted-password \"$6$x\"",
  ].join("\r\n"))).toEqual([
    "set system radius-server 192.0.2.60 secret \"$9$<masked>\"", "set snmp v3 usm local-engine user u authentication-sha authentication-key \"$9$<masked>\"",
    "set system login message \"$9$<masked>\"", "set system root-authentication encrypted-password \"$6$x\"",
  ]);
});

test("duplicates count once and order follows each side", () => {
  expect(diffConfigs("junos", "set a\nset b\nset b\n", "set c\nset a\nset c\n")).toEqual({ added: ["set c"], removed: ["set b"] });
});

const rules = (results: { rule: string; passed: boolean; detail: string }[]) => {
  for (const result of results) expect(result.detail.length).toBeGreaterThan(0);
  return results.map(({ rule, passed }) => [rule, passed]);
};

test("compliance: AOS-CX before/after", async () => {
  const before = checkCompliance("aoscx", await read("aoscx-before.cfg"));
  expect(rules(before)).toEqual([["ntp", true], ["aaa", true], ["snmpv2-off", false]]);
  expect(before[2]!.detail).toContain("public");
  expect(rules(checkCompliance("aoscx", await read("aoscx-after.cfg")))).toEqual([["ntp", true], ["aaa", true], ["snmpv2-off", true]]);
});

test("compliance: AOS-CX needs ntp enable and an AAA-first login", () => {
  const config = "ntp server 192.0.2.1\ntacacs-server host 192.0.2.5\naaa authentication login default local group tacacs\nsnmp-server community ro-one\nsnmp-server community ro-two\n";
  const result = checkCompliance("aoscx", config);
  expect(rules(result)).toEqual([["ntp", false], ["aaa", false], ["snmpv2-off", false]]);
  expect(result[2]!.detail).toContain("ro-one");
  expect(result[2]!.detail).toContain("ro-two");
  expect(rules(checkCompliance("aoscx", "ntp server 192.0.2.1\nntp enable\nradius-server host 192.0.2.6\naaa authentication login default group radius local\n")))
    .toEqual([["ntp", true], ["aaa", true], ["snmpv2-off", true]]);
  expect(rules(checkCompliance("aoscx", "ntp enable\naaa group server tacacs TAC\naaa authentication login default group TAC\n")))
    .toEqual([["ntp", false], ["aaa", false], ["snmpv2-off", true]]);
});

test("compliance: Junos rules", async () => {
  expect(rules(checkCompliance("junos", await Bun.file(path.join(import.meta.dir, "../tests/configs/junos-after.set")).text())))
    .toEqual([["ntp", true], ["aaa", true], ["snmpv2-off", true]]);
  const weak = checkCompliance("junos", [
    "set system tacplus-server 192.0.2.50 secret \"$9$x\"", "set system authentication-order [ password tacplus ]",
    "set snmp community public authorization read-only", "set snmp community \"noc ro\" authorization read-only",
  ].join("\n"));
  expect(rules(weak)).toEqual([["ntp", false], ["aaa", false], ["snmpv2-off", false]]);
  expect(weak[2]!.detail).toContain("public");
  expect(rules(checkCompliance("junos", "set system ntp server 192.0.2.1\nset system radius-server 192.0.2.6 secret \"$9$y\"\nset system authentication-order radius\n")))
    .toEqual([["ntp", true], ["aaa", true], ["snmpv2-off", true]]);
  expect(rules(checkCompliance("junos", "set system authentication-order [ tacplus password ]\n"))[1]).toEqual(["aaa", false]);
});
