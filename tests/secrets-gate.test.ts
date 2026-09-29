import { expect, test } from "bun:test";
import { hiddenSecretGate, NOT_RUN_REASON, NOT_WRITTEN_REASON } from "../src/secrets/gate";
import { Scrubber } from "../src/secrets/netconan";
import { scrubToolOutput } from "../src/secrets/tool-output";

const scrubber = new Scrubber({ env: { CASPER_NETCONAN: "off" } });

test("new text with <secret hidden> is not written; old text may hold it; normal edits pass", () => {
  expect(hiddenSecretGate("write", { path: "a.cfg", content: "radius-server host 1.1.1.1 key <secret hidden>" })).toBe(NOT_WRITTEN_REASON);
  expect(hiddenSecretGate("edit", { path: "a.cfg", edits: [{ oldText: "x", newText: "key <secret hidden>" }] })).toBe(NOT_WRITTEN_REASON);
  expect(hiddenSecretGate("edit", { path: "a.cfg", edits: [{ oldText: "key <secret hidden>", newText: "" }] })).toBeUndefined();
  expect(hiddenSecretGate("edit", { path: "a.cfg", edits: [{ oldText: "vlan 10", newText: "vlan 20" }] })).toBeUndefined();
  expect(hiddenSecretGate("write", { path: "a.cfg", content: "<line hidden: secret>" })).toBe(NOT_WRITTEN_REASON);
});

test("a shell command with the marker is not run; other commands and tools pass", () => {
  expect(hiddenSecretGate("bash", { command: "echo '<secret hidden>' > a.cfg" })).toBe(NOT_RUN_REASON);
  expect(hiddenSecretGate("powershell", { command: "Set-Content a.cfg '<secret hidden>'" })).toBe(NOT_RUN_REASON);
  expect(hiddenSecretGate("bash", { command: "cat backups/sw1.cfg" })).toBeUndefined();
  expect(hiddenSecretGate("read", { path: "<secret hidden>" })).toBeUndefined();
});

test("grep output from configs is scrubbed; source files and plain output are left alone", async () => {
  const grep = await scrubToolOutput(scrubber, "grep", { pattern: "community" }, ["backups/sw1.cfg:2:snmp-server community FixtureComm"]);
  expect(grep?.texts[0]).toBe("backups/sw1.cfg:2:snmp-server community <secret hidden>");
  expect(grep?.note).toBe("1 secret hidden before the AI saw this (SNMP communities).");
  expect(await scrubToolOutput(scrubber, "bash", { command: "ls" }, ["README.md\nsrc\n"])).toBeUndefined();
  expect(await scrubToolOutput(scrubber, "read", { path: "src/fixtures/sw1.ts" }, ["snmp-server community FixtureComm"])).toBeUndefined();
  expect(await scrubToolOutput(scrubber, "read", { path: "notes.txt" }, ["snmp-server community FixtureComm"])).toBeUndefined();
  expect(await scrubToolOutput(scrubber, "find", { pattern: "*" }, ["snmp-server community FixtureComm"])).toBeUndefined();
  const junos = await scrubToolOutput(scrubber, "read", { path: "oxidized/r1" }, ["set system root-authentication encrypted-password \"$6$abc$def\""]);
  expect(junos?.texts[0]).not.toContain("$6$abc$def");
});
