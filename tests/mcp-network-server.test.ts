import { expect, test } from "bun:test";
import path from "node:path";
import { NETWORK_SERVER, NETWORK_SERVER_NAME, networkServerEntry } from "../src/mcp/network/server";
import { runnerPin } from "../src/mcp/presets";
import type { MCPServerDefinition } from "../src/mcp/config";
import { lockedEntryPath } from "../src/security/install";

test("the network server is pinned, hash-locked and runs from an absolute path", () => {
  expect(NETWORK_SERVER_NAME).toBe("network");
  expect(NETWORK_SERVER.id).toBe("casper-network-mcp");
  expect(NETWORK_SERVER.version).toMatch(/^\d+\.\d+\.\d+$/);
  const lines = NETWORK_SERVER.source.lock.split("\n").filter((line) => line.trim() && !line.startsWith("#"));
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines.filter((l) => !l.startsWith(" "))) expect(line).toMatch(/==/);
  expect(NETWORK_SERVER.source.lock).toContain(`casper-network-mcp==${NETWORK_SERVER.version}`);
  expect(NETWORK_SERVER.source.lock).toMatch(new RegExp(`^casper-network-mcp==${NETWORK_SERVER.version.replace(/\./g, "\\.")} .*--hash=sha256:[0-9a-f]{64}`, "m"));
  expect(lines.some((l) => /^(-e\s|\.\s*$|\.\/)/.test(l.trim()))).toBe(false); // no editable or local project line
  expect(NETWORK_SERVER.source.lock).toMatch(/--hash=sha256:[0-9a-f]{64}/);
  // Each requirement is followed by at least one --hash line.
  const blocks = NETWORK_SERVER.source.lock.split(/\n(?=[A-Za-z0-9])/).filter((block) => !block.startsWith("#"));
  for (const block of blocks) expect(block).toMatch(/--hash=sha256:[0-9a-f]{64}/);
  const entry = networkServerEntry("/home/someone");
  expect(path.isAbsolute(entry.command)).toBe(true);
  expect(entry).toEqual({ command: lockedEntryPath("/home/someone", NETWORK_SERVER), args: [], env: {} });
  const definition: MCPServerDefinition = { name: NETWORK_SERVER_NAME, source: "/home/someone/.casper/mcp.json", cwd: "/home/someone", disabled: false,
    transport: { type: "stdio", ...entry } };
  expect(runnerPin(definition)).toBeUndefined(); // not a package runner: can be remembered, never fetches
});
