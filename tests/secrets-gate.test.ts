import { expect, test } from "bun:test";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hiddenSecretGate, NOT_RUN_REASON, NOT_WRITTEN_REASON } from "../src/secrets/gate";
import { Scrubber } from "../src/secrets/netconan";
import { scrubToolOutput } from "../src/secrets/tool-output";
import { removeTempDir } from "./support/temp-dir";

const scrubber = new Scrubber({ env: { CASPER_NETCONAN: "off" } });

test("new text with <secret hidden> is not written; old text may hold it; normal edits pass", () => {
  expect(hiddenSecretGate("write", { path: "a.cfg", content: "radius-server host 1.1.1.1 key <secret hidden>" })).toBe(NOT_WRITTEN_REASON);
  expect(hiddenSecretGate("edit", { path: "a.cfg", edits: [{ oldText: "x", newText: "key <secret hidden>" }] })).toBe(NOT_WRITTEN_REASON);
  expect(hiddenSecretGate("edit", { path: "a.cfg", edits: [{ oldText: "key <secret hidden>", newText: "" }] })).toBeUndefined();
  expect(hiddenSecretGate("edit", { path: "a.cfg", edits: [{ oldText: "vlan 10", newText: "vlan 20" }] })).toBeUndefined();
  expect(hiddenSecretGate("write", { path: "a.cfg", content: "<line hidden: secret>" })).toBe(NOT_WRITTEN_REASON);
});

test("a write that creates a new file may quote the marker; overwriting a file or editing one may not", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-secrets-gate-"));
  try {
    await writeFile(path.join(root, "a.cfg"), "key RealKey\n");
    await symlink(path.join(root, "gone.cfg"), path.join(root, "link.cfg"));
    const note = "The scrubber showed <secret hidden> in place of a plain word.\n";
    expect(hiddenSecretGate("write", { path: "notes/false-positive.md", content: note }, root)).toBeUndefined();
    expect(hiddenSecretGate("write", { path: path.join(root, "new.md"), content: note }, root)).toBeUndefined();
    expect(hiddenSecretGate("write", { path: "a.cfg", content: "key <secret hidden>\n" }, root)).toBe(NOT_WRITTEN_REASON);
    expect(hiddenSecretGate("write", { path: "link.cfg", content: note }, root)).toBe(NOT_WRITTEN_REASON);
    expect(hiddenSecretGate("edit", { path: "new.md", edits: [{ oldText: "x", newText: note }] }, root)).toBe(NOT_WRITTEN_REASON);
    // Without a folder to look in, every write with the marker is still refused.
    expect(hiddenSecretGate("write", { path: "notes/false-positive.md", content: note })).toBe(NOT_WRITTEN_REASON);
  } finally { await removeTempDir(root); }
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

test("reading back Pi's saved output of a long command is scrubbed like command output", async () => {
  const config = "hostname sw1\nsnmp-server community SavedComm RO\n";
  const saved = await scrubToolOutput(scrubber, "read", { path: "/tmp/pi-bash-0123456789abcdef.log" }, [config]);
  expect(saved?.texts[0]).toBe("hostname sw1\nsnmp-server community <secret hidden> RO\n");
  const shell = await scrubToolOutput(scrubber, "read", { path: "C:\\Temp\\pi-powershell-00ff.log", offset: 1 }, [config]);
  expect(shell?.texts[0]).not.toContain("SavedComm");
  // Plain command output in that file, and other .log files, are left alone.
  expect(await scrubToolOutput(scrubber, "read", { path: "/tmp/pi-bash-0123456789abcdef.log" }, ["build ok\n"])).toBeUndefined();
  expect(await scrubToolOutput(scrubber, "read", { path: "logs/app.log" }, [config])).toBeUndefined();
});
