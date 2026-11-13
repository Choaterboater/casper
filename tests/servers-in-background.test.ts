import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import type { MCPServerDefinition } from "../src/mcp/config";
import { SkillRegistry } from "../src/skills/registry";
import { childTestLimit } from "./support/limits";
import { removeTempDir } from "./support/temp-dir";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const fixture = path.join(import.meta.dir, "fixtures/mcp-server.ts");

/** An app whose one MCP server never answers its start (the app's own, as `casper acp` hands it over). */
async function appWithStalledServer(serversInBackground: boolean) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-bg-servers-"));
  cleanup.push(() => removeTempDir(root));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  await mkdir(path.join(home, ".casper"), { recursive: true });
  await mkdir(project);
  const stalled: MCPServerDefinition = { name: "stalled", source: "fixture", scope: "client", cwd: project, disabled: false,
    // Longer than the start below may take: a start that waits for this server fails the test.
    limits: { connectMs: 20_000 },
    transport: { type: "stdio", command: process.execPath, args: [fixture], env: { FIXTURE_MODE: "stall" } } };
  const app = new CasperApp({
    output: { write() {} }, runtimeFactory() { throw new Error("No model expected"); }, sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [stalled], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  app.serversInBackground = serversInBackground;
  cleanup.push(() => app.close());
  return { app, project };
}

test("a long-lived session starts without waiting for its MCP servers", async () => {
  const { app, project } = await appWithStalledServer(true);
  const started = performance.now();
  await app.start(project);
  expect(performance.now() - started).toBeLessThan(10_000);
  // The server is still starting, after the session has.
  expect(app.mcp!.status()[0]).toMatchObject({ name: "stalled", state: "connecting" });
}, childTestLimit());
