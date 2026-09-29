import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import os from "node:os";
import path from "node:path";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import { SkillRegistry } from "../src/skills/registry";
import { discoverMCPConfiguration } from "../src/mcp/config";
import { Scrubber } from "../src/secrets/netconan";
import type { AgentRuntime, RuntimeStartOptions, RuntimeTool } from "../src/runtime/types";

const network = path.join(import.meta.dir, "fixtures/mcp-network-server.ts");
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(casper?: unknown) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-secrets-app-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  await mkdir(path.join(project, ".casper"), { recursive: true });
  await mkdir(path.join(home, ".casper"), { recursive: true });
  if (casper) await writeFile(path.join(home, ".casper/mcp.json"), JSON.stringify(casper));
  return { home, project };
}

interface SessionOptions {
  answers?: string[];
  yes?: string[];
  model?: (tools: RuntimeTool[]) => Promise<void>;
  runGit?: (argv: string[]) => Promise<{ code: number | null }>;
}
/** An interactive session on the plain terminal; `yes` answers each "Type yes:" in order (default yes). */
async function session(home: string, project: string, commands: string[], options: SessionOptions = {}) {
  const runtime: AgentRuntime = {
    async start(start: RuntimeStartOptions) {
      let tools = start.tools ?? [];
      return {
        setTools: (next: RuntimeTool[]) => { tools = next; },
        prompt: async () => { await options.model?.(tools); },
        abort: async () => {}, subscribe: () => () => {}, getState: () => ({ cwd: start.cwd, isStreaming: false }),
      };
    },
    async dispose() {},
  };
  const input = new PassThrough();
  let output = "";
  const pending = [...commands];
  const answers = [...options.answers ?? []];
  const yes = [...options.yes ?? []];
  const app = new CasperApp({
    runtimeFactory: () => runtime, input, sessionHomeDir: home,
    scrubber: new Scrubber({ env: { PATH: path.join(home, "no-such-bin") } }),
    ...(options.runGit ? { runGit: options.runGit } : {}),
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: () => discoverMCPConfiguration({ projectRoot: project, homeDir: home, platform: "linux" }),
    output: { write: (text) => {
      output += text;
      if (text === "> ") queueMicrotask(() => input.write(`${pending.shift() ?? "/exit"}\n`));
      if (text.endsWith("Type 1 or 2: ")) queueMicrotask(() => input.write(`${answers.shift() ?? "2"}\n`));
      if (text.endsWith("Type yes: ")) queueMicrotask(() => input.write(`${yes.shift() ?? "yes"}\n`));
    } },
  });
  cleanup.push(() => app.close());
  await app.runInteractive(project);
  return { output, app };
}

test("/secrets says what is hidden; /secrets files off and on switch file scrubbing for this session", async () => {
  const { home, project } = await fixture();
  const { output, app } = await session(home, project, ["/secrets", "/secrets files off", "/secrets", "/secrets files on", "/secrets files maybe"]);
  expect(output).toContain("Secrets: hidden in MCP results, .env and credential files (always). Device configs in files and command output: on. Extra check: netconan not found (built-in only).");
  expect(output).toContain("Device configs in files and command output: off for this session. MCP results, .env and credential files are still scrubbed.");
  expect(output).toContain("Device configs in files and command output: off. Extra check");
  expect(output).toContain("Device configs in files and command output: on.\n");
  expect(output).toContain("Usage: /secrets | /secrets files on|off");
  expect(app.scrubFiles).toBe(true);
});

test("an MCP result the model reads through the app has its secrets hidden", async () => {
  const { home, project } = await fixture({ mcpServers: { lab: { command: process.execPath, args: [network], env: { FIXTURE_MODE: "config" } } } });
  let seen = "";
  await session(home, project, ["/mcp connect lab", "show me the config"], {
    model: async (tools) => {
      seen = (await tools.find((tool) => tool.name === "call_capability")!.execute({ id: "mcp:lab:get_running_config", arguments: {} })).text;
    },
  });
  expect(seen).toContain("<secret hidden>");
  for (const secret of ["AQBapFixtureCipher", "RadKeyCX", "FixtureComm", "SuperPSK123"]) expect(seen).not.toContain(secret);
  expect(seen).toContain("4 secrets hidden before the AI saw this");
});

test("/references add lists the spec repos; a no downloads nothing; a yes runs the shown git commands and adds the entry", async () => {
  const { home, project } = await fixture();
  const runs: string[][] = [];
  const runGit = async (argv: string[]) => { runs.push(argv); return { code: 0 }; };
  const list = await session(home, project, ["/references add", "/references add junos-yang"], { runGit });
  expect(list.output).toContain("mist-openapi  Mist API spec (MIT)");
  expect(list.output).toContain("pycentral     Aruba Central Python SDK (Apache-2.0)");
  expect(list.output).toContain("Usage: /references add junos-yang <release>, for example 23.4");

  const declined = await session(home, project, ["/references add pycentral"], { runGit, yes: ["no"] });
  expect(declined.output).toContain("Will run: git -c core.hooksPath=/dev/null clone --depth 1 --filter=blob:none --sparse https://github.com/aruba/pycentral.git ~/.casper/reference-repos/pycentral");
  expect(declined.output).toContain("Download now? Type yes: ");
  expect(declined.output).toContain("Nothing downloaded.");
  expect(runs).toEqual([]);
  expect(await Bun.file(path.join(home, ".casper/references.yaml")).exists()).toBe(false);

  const added = await session(home, project, ["/references add pycentral", "/references add pycentral"], { runGit });
  expect(runs[0]).toEqual(["git", "-c", "core.hooksPath=/dev/null", "clone", "--depth", "1", "--filter=blob:none", "--sparse",
    "https://github.com/aruba/pycentral.git", path.join(home, ".casper/reference-repos/pycentral")]);
  expect(added.output).toContain("Added pycentral to ~/.casper/references.yaml. Restart Casper to search it.");
  expect(added.output).toContain("pycentral is already in ~/.casper/references.yaml. Nothing changed.");
  expect(await readFile(path.join(home, ".casper/references.yaml"), "utf8")).toContain("pycentral:");
});

test("/references add says so when git fails, and adds nothing", async () => {
  const { home, project } = await fixture();
  const { output } = await session(home, project, ["/references add mist-openapi"], { runGit: async () => ({ code: 128 }) });
  expect(output).toContain("Download failed (git exit 128). Nothing was added.");
  expect(await Bun.file(path.join(home, ".casper/references.yaml")).exists()).toBe(false);
});

test("/mcp docs lists the docs server and adds a docs-only copy with no credentials to ~/.casper/mcp.json", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "casper-hpe-repo-"));
  cleanup.push(() => rm(repo, { recursive: true, force: true }));
  // The fixture ignores the extra argument; Casper reads it to find the router.
  const router = `${repo}/src/hpe_networking_mcp/mcp_servers/tool_router.py`;
  const { home, project } = await fixture({ mcpServers: {
    hpe: { command: process.execPath, args: [network, router], cwd: repo,
      env: { FIXTURE_MODE: "hpe-docs", PYTHONPATH: `${repo}/src`, CREDS_PATH: `${repo}/creds.yaml`, HPE_MCP_TOOLSETS: "central,rag", MIST_API_TOKEN: "tok-123456" } },
  } });
  const declined = await session(home, project, ["/mcp connect hpe", "/mcp docs"], { yes: ["no"] });
  expect(declined.output).toContain("Docs servers: hpe (lookup_api, search_docs, ask_docs). No docs-only server yet.");
  expect(declined.output).toContain("Will add hpe-docs to ~/.casper/mcp.json:");
  expect(declined.output).toContain("  env: PYTHONPATH (no credentials, no device settings)");
  expect(declined.output).toContain("Add a docs-only copy (no passwords, no device access)? Type yes: ");
  expect(declined.output).toContain("Nothing added.");
  expect(declined.output).not.toContain("tok-123456");

  const added = await session(home, project, ["/mcp docs"]);
  expect(added.output).toContain("Added hpe-docs to ~/.casper/mcp.json. Run /mcp reload, then /mcp connect hpe-docs.");
  const file = JSON.parse(await readFile(path.join(home, ".casper/mcp.json"), "utf8"));
  expect(Object.keys(file.mcpServers)).toEqual(["hpe", "hpe-docs"]);
  expect(file.mcpServers["hpe-docs"]).toEqual({
    command: process.execPath, args: [network, `${repo}/src/hpe_networking_mcp/mcp_servers/rag.py`],
    cwd: repo, env: { PYTHONPATH: `${repo}/src` },
  });
  const again = await session(home, project, ["/mcp docs"]);
  expect(again.output).toContain("Docs-only server: hpe-docs.");
  expect(again.output).not.toContain("Add a docs-only copy");
});

test("a /delegate child gets the same scrubbing, and /secrets files off stops it there too", async () => {
  const { home, project } = await fixture();
  const seen: Array<Awaited<ReturnType<NonNullable<RuntimeStartOptions["scrubToolOutput"]>>> | "none"> = [];
  const child: AgentRuntime = {
    async start() { throw new Error("children start read-only"); },
    async startReadOnly(options) {
      return {
        prompt: async () => {
          seen.push(options.scrubToolOutput ? await options.scrubToolOutput("read", { path: "backups/sw1.cfg" }, ["snmp-server community ChildComm"]) : "none");
        },
        abort: async () => {}, subscribe: () => () => {}, getState: () => ({ cwd: options.cwd, isStreaming: false }),
      };
    },
    async dispose() {},
  };
  for (const filesOn of [true, false]) {
    const app = new CasperApp({
      runtimeFactory: () => { throw new Error("the parent stays lazy"); }, subagentRuntimeFactory: () => child, sessionHomeDir: home,
      scrubber: new Scrubber({ env: { CASPER_NETCONAN: "off" } }),
      loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
      loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
      loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
      output: { write: () => {} },
    });
    cleanup.push(() => app.close());
    app.scrubFiles = filesOn;
    await app.runOnce("/delegate explorer Find the snmp settings", project).catch(() => {});
  }
  expect(seen).toEqual([{ texts: ["snmp-server community <secret hidden>"], note: "1 secret hidden before the AI saw this (SNMP communities)." }, undefined]);
});

test("/mcp docs does not copy a router started with extra settings, and says why", async () => {
  const { home, project } = await fixture({ mcpServers: {
    hpe: { command: "uv", args: ["run", "--env-file", "/repo/.env", "/repo/src/hpe_networking_mcp/mcp_servers/tool_router.py"], env: { PYTHONPATH: "/repo/src" } },
  } });
  const { output } = await session(home, project, ["/mcp docs"]);
  expect(output).toContain("No docs-only server yet.");
  expect(output).toContain("A router started with extra settings (like --env-file) is not copied");
  expect(output).not.toContain("Type yes");
  expect(Object.keys(JSON.parse(await readFile(path.join(home, ".casper/mcp.json"), "utf8")).mcpServers)).toEqual(["hpe"]);
});
