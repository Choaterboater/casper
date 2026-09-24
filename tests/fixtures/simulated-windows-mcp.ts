// Run in a separate Bun process: module substitution must not affect other suites.
// Simulates Windows ownership (no process groups, per-PID termination) over the real
// POSIX process table, so the MCP manager's liveness predicate meets a real SDK close.
import { mock } from "bun:test";
import assert from "node:assert/strict";
import path from "node:path";
import * as processes from "../../src/platform/processes";

const signalled: number[] = [];
const owned = new Set<number>();
const platform: processes.ProcessPlatform = {
  groups: false,
  list: processes.posixProcessPlatform.list,
  signalProcess: (pid, signal) => { signalled.push(pid); process.kill(pid, signal); },
  signalGroup: () => { throw new Error("No Windows process groups"); },
};
mock.module("../../src/platform/processes", () => ({
  ...processes,
  ownSpawnedTree: (pid: number | null | undefined, alive: () => boolean) => {
    if (!pid) return undefined;
    owned.add(pid);
    return new processes.OwnedProcesses(pid, alive, platform);
  },
}));

const { MCPManager } = await import("../../src/mcp/manager");
const manager = new MCPManager({ servers: [{ name: "stubborn", source: "fixture", cwd: process.cwd(), disabled: false,
  transport: { type: "stdio", command: process.execPath, args: [path.join(import.meta.dir, "mcp-server.ts")], env: { FIXTURE_MODE: "stubborn" } } }], diagnostics: [] });
try {
  await manager.connect("stubborn");
  assert.equal(manager.status()[0]?.state, "ready");
  const [root] = owned;
  assert.ok(root, "The real caller must use the substituted ownership seam");
  // The SDK clears its pid getter synchronously in close(); the root must still be signalled.
  await manager.disconnect("stubborn");
  assert.ok(signalled.includes(root), `root ${root} was not signalled: ${JSON.stringify(signalled)}`);
  let alive = true;
  for (let attempt = 0; attempt < 100 && alive; attempt++) {
    try { process.kill(root, 0); await Bun.sleep(20); } catch { alive = false; }
  }
  assert.equal(alive, false);
  manager.assertCleanup();
  console.log("simulated windows mcp: root stopped");
} finally {
  await manager.close().catch(() => {});
  for (const pid of owned) { try { process.kill(pid, "SIGKILL"); } catch {} }
}
