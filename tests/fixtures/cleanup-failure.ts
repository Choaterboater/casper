// Run in a separate Bun process: module substitution must not affect other suites.
import { mock } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as processes from "../../src/platform/processes";

const owned = new Set<number>();
const platform: processes.ProcessPlatform = {
  groups: false,
  list: async () => { throw new Error("Synthetic unavailable Windows process table"); },
  signalProcess: () => { throw new Error("Unverified process must not be signalled"); },
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

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-cleanup-failure-")));
const home = path.join(root, "home"), project = path.join(root, "project");
await mkdir(home); await mkdir(project);
const mode = process.argv[2];
try {
  if (mode === "verifier") {
    const { runCommandCheck } = await import("../../src/verify/command");
    const { checkCommand } = await import("../support/check-command");
    let blocked = false;
    const result = await runCommandCheck({ name: "test", command: checkCommand("sleep:10000"), cwd: project,
      timeoutMs: 100, onCleanupFailure: () => { blocked = true; } });
    assert.equal(result.status, "fail");
    assert.match(result.reason!, /cleanup is unconfirmed/);
    assert.equal(blocked, true);
  } else if (mode === "app-verifier") {
    const { CasperApp } = await import("../../src/app");
    const { checkCommand } = await import("../support/check-command");
    const { loadProjectContext } = await import("../../src/project/context");
    const { SkillRegistry } = await import("../../src/skills/registry");
    await mkdir(path.join(project, ".casper"));
    await writeFile(path.join(project, ".casper/project.yaml"), JSON.stringify({ verify: { test: checkCommand() } }));
    let starts = 0;
    const app = new CasperApp({ runtimeFactory: () => { starts++; throw new Error("No runtime may start"); },
      output: { write() {} }, sessionHomeDir: home,
      loadProjectContext: info => loadProjectContext(info, { homeDir: home }),
      loadSkillRegistry: context => SkillRegistry.discover({ homeDir: home, projectRoot: context.info.root }),
      loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
      loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
      loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
    });
    try {
      const report = await app.runOnce("/verify repair test", project);
      assert.notEqual(report?.status, "pass");
      await assert.rejects(() => app.runOnce("continue"), /cleanup is unconfirmed/);
      await app.runOnce("/status"); // cleanup failure must not leave commandActive latched
      assert.equal(starts, 0);
    } finally { await app.close(); }
  } else if (mode === "lsp") {
    const { LSPManager } = await import("../../src/lsp/manager");
    const manager = new LSPManager(project, { servers: [{ name: "test", source: "fixture", command: process.execPath,
      args: [path.join(import.meta.dir, "lsp-server.ts")], languages: { ".ts": "typescript" } }], diagnostics: [] });
    await manager.connect("test");
    await assert.rejects(() => manager.disconnect("test"), /cleanup is unconfirmed/);
    await assert.rejects(() => manager.connect("test"), /cleanup is unconfirmed/);
    assert.throws(() => manager.assertCleanup(), /cleanup is unconfirmed/);
    await manager.close().catch(() => {});
  } else if (mode === "mcp") {
    const { MCPManager } = await import("../../src/mcp/manager");
    const manager = new MCPManager({ servers: [{ name: "test", source: "fixture", cwd: project, disabled: false,
      transport: { type: "stdio", command: process.execPath, args: [path.join(import.meta.dir, "mcp-server.ts")], env: {} } }], diagnostics: [] });
    await manager.connect("test");
    await assert.rejects(() => manager.disconnect("test"), /cleanup is unconfirmed/);
    await assert.rejects(() => manager.connect("test"), /cleanup is unconfirmed/);
    assert.throws(() => manager.assertCleanup(), /cleanup is unconfirmed/);
    await manager.close().catch(() => {});
  } else if (mode === "browser") {
    const { BrowserSession } = await import("../../src/browser/session");
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("probe") });
    const url = `http://127.0.0.1:${probe.port}`;
    await probe.stop(true);
    await writeFile(path.join(project, "dev.ts"), 'Bun.serve({hostname:"127.0.0.1",port:Number(process.env.PORT),fetch:()=>new Response("ready")});');
    await writeFile(path.join(project, "package.json"), JSON.stringify({ scripts: { dev: `"${process.execPath}" dev.ts` } }));
    const session = new BrowserSession({ projectRoot: project, stateDirectory: home });
    await session.run({ action: "serve", script: "dev", url, impact: "local-test", reason: "Fixture" });
    await assert.rejects(() => session.close(), /cleanup is unconfirmed/);
    assert.equal(session.status().ownedProcessCleanup, "unknown");
    assert.throws(() => session.assertCleanup(), /cleanup is unconfirmed/);
    await assert.rejects(() => session.close(), /cleanup is unconfirmed/);
  } else throw new Error("Unknown fixture mode");
  assert.ok(owned.size > 0, "The real caller must use the substituted ownership seam");
  console.log(`${mode}: cleanup failure propagated`);
} finally {
  // Only this fixture's own processes. POSIX-gated by the parent test because
  // its synthetic failed listing deliberately prevents production cleanup.
  for (const pid of owned) {
    try { process.kill(-pid, "SIGKILL"); }
    catch { try { process.kill(pid, "SIGKILL"); } catch {} }
  }
  await Bun.sleep(100);
  await rm(root, { recursive: true, force: true });
}
