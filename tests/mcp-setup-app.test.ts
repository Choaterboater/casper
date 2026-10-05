import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import os from "node:os";
import path from "node:path";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import { SkillRegistry } from "../src/skills/registry";
import { discoverMCPConfiguration } from "../src/mcp/config";
import type { AgentRuntime, RuntimeStartOptions, RuntimeTool } from "../src/runtime/types";

const network = path.join(import.meta.dir, "fixtures/mcp-network-server.ts");
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(files: { claude?: unknown; casper?: unknown }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-setup-app-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  await mkdir(path.join(project, ".casper"), { recursive: true });
  await mkdir(path.join(home, ".casper"), { recursive: true });
  if (files.claude) await writeFile(path.join(home, ".claude.json"), JSON.stringify(files.claude));
  if (files.casper) await writeFile(path.join(home, ".casper/mcp.json"), JSON.stringify(files.casper));
  return { home, project };
}
const entry = (env: Record<string, string>, args: string[] = []) => ({ command: process.execPath, args: [network, ...args], env });

/**
 * An interactive session on the plain terminal. `commands` are typed at each prompt, `answers` at
 * each "Type 1 or 2" box, in order. `model` runs when a command is not a slash command.
 */
async function session(home: string, project: string, commands: string[], answers: string[] = [],
  model?: (tools: RuntimeTool[]) => Promise<void>) {
  const runtime: AgentRuntime = {
    async start(options: RuntimeStartOptions) {
      let tools = options.tools ?? [];
      return {
        setTools: (next: RuntimeTool[]) => { tools = next; },
        prompt: async () => { await model?.(tools); },
        abort: async () => {}, subscribe: () => () => {}, getState: () => ({ cwd: options.cwd, isStreaming: false }),
      };
    },
    async dispose() {},
  };
  const input = new PassThrough();
  let output = "";
  const pending = [...commands];
  const app = new CasperApp({
    runtimeFactory: () => runtime, input, sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: () => discoverMCPConfiguration({ projectRoot: project, homeDir: home, platform: "linux" }),
    output: { write: (text) => {
      output += text;
      if (text === "> ") queueMicrotask(() => input.write(`${pending.shift() ?? "/exit"}\n`));
      // Every numbered box (remember, writes, a change): the next scripted answer, else 1 (the safe choice).
      if (/Type [\d, ]*\d or \d: $/.test(text)) queueMicrotask(() => input.write(`${answers.shift() ?? "1"}\n`));
    } },
  });
  cleanup.push(() => app.close());
  await app.runInteractive(project);
  return { output, app };
}

test("imported servers are announced once per new set, listed with where they came from, and need a connect", async () => {
  const { home, project } = await fixture({ claude: { mcpServers: {
    "aruba-central": entry({ FIXTURE_MODE: "access-bad", CENTRALMCP_READONLY: "0" }),
    lab: entry({ FIXTURE_MODE: "access-bad" }),
  } } });
  const first = await session(home, project, ["/mcp"]);
  expect(first.output).toContain("[mcp] Found 2 servers in ~/.claude.json. Run /mcp to see them.");
  expect(first.output).toContain("aruba-central [stdio; disconnected] 0 tools · from ~/.claude.json · preset: centralmcp · writes off");
  expect(first.output).toContain("  Found in ~/.claude.json. Not approved yet · /mcp connect aruba-central");
  expect(first.output).toContain("  preset: centralmcp (read-only pins sent, not confirmed: CENTRALMCP_READONLY=1)");
  const second = await session(home, project, ["/mcp"]);
  expect(second.output).not.toContain("[mcp] Found");
});

test("after /mcp connect, 1 remembers nothing; 2 remembers it, and the next session connects it with writes off", async () => {
  const { home, project } = await fixture({ casper: { mcpServers: { lab: entry({ FIXTURE_MODE: "access-bad" }) } } });
  const consentFile = path.join(home, ".casper/mcp-consent.json");
  const declined = await session(home, project, ["/mcp connect lab"], ["1"]);
  expect(declined.output).toContain("Next time it connects on its own, with writes off. Every change still asks you.\nRemember lab?\n  1 No\n  2 Yes\n");
  expect(declined.output).toContain("[mcp] Not remembered. lab is connected for this session only.");
  expect(await Bun.file(consentFile).exists()).toBe(false);
  const remembered = await session(home, project, ["/mcp connect lab"], ["2"]);
  expect(remembered.output).toContain("[mcp] Remembered lab. It connects on its own next time, with writes off. /mcp forget lab undoes this.");
  expect(await Bun.file(consentFile).exists()).toBe(true);
  const next = await session(home, project, ["/mcp", "/mcp disconnect lab"]);
  expect(next.output).toContain("  Remembered: connects on its own, with writes off.");
  // After /mcp disconnect it no longer connects on its own in this session, so /mcp doesn't say it does.
  expect(next.output.split("Remembered: connects on its own").length - 1).toBe(1);
  expect(next.app.mcp!.status()[0]).toMatchObject({ approved: false, consent: "remembered", writes: "off" });
  const forgot = await session(home, project, ["/mcp forget lab", "/mcp"]);
  expect(forgot.output).toContain("[mcp] Forgot lab. Casper asks again before it connects next time.");
  expect(forgot.app.mcp!.status()[0]).toMatchObject({ consent: "none" });
});

test("an unpinned package runner is never remembered, and the box is not shown", async () => {
  const { home, project } = await fixture({ casper: { mcpServers: {
    karthik: { command: process.execPath, args: [network, "central-mcp-server"], env: { FIXTURE_MODE: "karthik-like" } },
  } } });
  const { output } = await session(home, project, ["/mcp connect karthik"]);
  expect(output).toContain("[mcp] Not remembered: karthik is not pinned to a version. An update could add write tools. Pin it (for example ==1.4.2 or a commit) and connect again.");
  expect(output).not.toContain("Remember karthik?");
});

test("writes on takes /mcp writes and then 2; 1 changes nothing; 2 drops the pins, shows the badge, and /mcp writes off reverts", async () => {
  const { home, project } = await fixture({ casper: { mcpServers: {
    "aruba-central": entry({ FIXTURE_MODE: "access-bad", FIXTURE_ENV_DUMP: "1", CENTRALMCP_READONLY: "0" }),
  } } });
  const envSeen: string[] = [];
  const readEnv = async (tools: RuntimeTool[]) => {
    const call = tools.find((tool) => tool.name === "call_capability")!;
    envSeen.push((await call.execute({ id: "mcp:aruba-central:get_env", arguments: {} })).text);
  };
  const { output, app } = await session(home, project, [
    "/mcp connect aruba-central", "/mcp writes aruba-central", "read env", "/mcp writes aruba-central", "read env", "/mcp writes off", "read env",
  ], ["1", "1", "2"], readEnv);
  expect(output).toContain("Central writes are off.\n  1 Keep writes off\n  2 Enable for this server\nType 1 or 2: ");
  expect(output).toContain("[mcp] Writes stay off for aruba-central.");
  expect(output).toContain("[mcp] Writes on for aruba-central. Each change still asks you. /mcp writes off turns writes off.");
  expect(output).toContain("[mcp] Writes off for aruba-central. Every change asks you again.");
  const readOnly = envSeen.map((text) => (JSON.parse(text) as { data: { content: { data: { env: Record<string, string> } }[] } }).data.content[0]!.data.env.CENTRALMCP_READONLY);
  expect(readOnly).toEqual(["1", "0", "1"]);
  expect(app.terminal.badge).toBeUndefined();
});

test("the footer badge names the servers with writes on", async () => {
  const { home, project } = await fixture({ casper: { mcpServers: { "aruba-central": entry({ FIXTURE_MODE: "access-bad", CENTRALMCP_READONLY: "0" }) } } });
  const { app } = await session(home, project, ["/mcp connect aruba-central", "/mcp writes aruba-central"], ["1", "2"]);
  expect(app.terminal.badge).toBe("WRITES: aruba-central · /mcp writes off");
});

test("the model's ask tool can't turn writes on or approve a change: the change box still asks the user", async () => {
  const { home, project } = await fixture({ casper: { mcpServers: { lab: entry({ FIXTURE_MODE: "access-bad" }) } } });
  let asked = "";
  const { output, app } = await session(home, project, ["/mcp connect lab", "enable writes please"], ["1", "1"], async (tools) => {
    const ask = tools.find((tool) => tool.name === "ask")!;
    asked = (await ask.execute({ question: "lab writes are off.", options: [{ label: "1 Keep writes off" }, { label: "2 Enable for this server" }] })).text;
    const call = tools.find((tool) => tool.name === "call_capability")!;
    asked += (await call.execute({ id: "mcp:lab:set_config", arguments: {} })).text;
  });
  expect(app.mcp!.writesOn()).toEqual([]);
  // Whatever the AI's own question said, the change went to the user's box, and their 1 (No) kept it from running.
  expect(output).toContain("Change in lab: set config");
  expect(output).toContain("[approval] denied");
  expect(asked).toContain("Not executed (you said no)");
  expect(output).not.toContain("[mcp] Writes on");
});

test("the enable text says when your own settings still keep writes off, and a read-only login can't turn writes on", async () => {
  const { home, project } = await fixture({ casper: { mcpServers: {
    hpe: entry({ FIXTURE_MODE: "hpe-router", HPE_MCP_ACCESS_PROFILE: "safe-read-only" }),
    ro: entry({ FIXTURE_MODE: "access-ro" }),
  } } });
  const { output } = await session(home, project, ["/mcp connect hpe", "/mcp writes hpe", "/mcp connect ro", "/mcp writes ro"], ["1", "2", "1"]);
  expect(output).toContain("HPE networking writes are off.");
  expect(output).toContain(`[mcp] Casper removed its read-only pins, but your own settings still keep writes off (HPE_MCP_ACCESS_PROFILE=safe-read-only in ${path.join(home, ".casper/mcp.json")}).`);
  expect(output).toContain("ro [stdio; ready] 3 tools · writes off · login: read-only (checked)");
  expect(output).toContain("[mcp] This login is read-only (access_check). Writes can't be turned on here.");
});

test("a changed definition says so in /mcp; junos-show is a per-server opt-in the user types", async () => {
  const { home, project } = await fixture({ casper: { mcpServers: {
    lab: entry({ FIXTURE_MODE: "access-bad", SITE: "one" }),
    junos: entry({ FIXTURE_MODE: "junos" }, ["jmcp.py"]),
  } } });
  await session(home, project, ["/mcp connect lab"], ["2"]);
  await writeFile(path.join(home, ".casper/mcp.json"), JSON.stringify({ mcpServers: {
    lab: entry({ FIXTURE_MODE: "access-bad", SITE: "two" }), junos: entry({ FIXTURE_MODE: "junos" }, ["jmcp.py"]),
  } }));
  const { output } = await session(home, project, ["/mcp", "/mcp connect junos", "/mcp junos-show junos on", "/mcp", "/mcp junos-show lab on"], ["1"]);
  expect(output).toContain("  Changed since you approved it. Run /mcp connect lab.");
  expect(output).toContain("[mcp] Plain show commands on junos run without asking.");
  expect(output).toContain("  Plain show commands run without asking (/mcp junos-show junos off).");
  expect(output).toContain("lab is not a Junos server.");
});

// --- /mcp allow <server>: the change-kind picker ------------------------------------------------

test("/mcp allow: 1 keeps the defaults; a kind can be allowed for this session or remembered; off clears", async () => {
  const { home, project } = await fixture({ casper: { mcpServers: { lab: entry({ FIXTURE_MODE: "access-bad" }) } } });
  // connect (1 Just this time), allow: 1 keep; allow: 3 deletes then 2 remember; allow: 2 firmware then 1 session.
  const first = await session(home, project, ["/mcp connect lab", "/mcp allow lab", "/mcp allow lab", "/mcp allow lab"],
    ["1", "1", "3", "2", "2", "1"]);
  expect(first.output).toContain([
    "lab change kinds. Firmware changes, deletes and admin changes are off by default; every change still asks you.",
    "  Allowed now: none",
    "Which change kinds may lab make?",
    "  1 Keep the defaults",
    "  2 Allow firmware changes",
    "  3 Allow deletes",
    "  4 Allow admin and account changes",
    "  5 Allow all change kinds",
    "  6 Allow everything (no asking) this session",
    "Type 1, 2, 3, 4, 5 or 6: ",
  ].join("\n"));
  expect(first.output).toContain("[mcp] lab keeps the defaults.");
  expect(first.output).toContain("  1 This session\n  2 Remember\nType 1 or 2: ");
  expect(first.output).toContain("[mcp] Deletes allowed on lab, remembered. /mcp allow lab off undoes this.");
  expect(first.output).toContain("[mcp] Firmware changes allowed on lab for this session.");
  expect(first.app.allowances!.kindAllowed("lab", "firmware")).toBe(true);
  expect(first.app.allowances!.kindAllowed("lab", "delete")).toBe(true);
  expect(first.app.allowances!.kindAllowed("lab", "admin")).toBe(false);
  // A new session: the remembered kind is still there, the session one is not.
  const second = await session(home, project, ["/mcp connect lab", "/mcp allow lab", "/mcp allow lab off", "/mcp allow lab"], ["1", "1", "1"]);
  expect(second.output).toContain("  Allowed now: Deletes (remembered)");
  expect(second.output).toContain("[mcp] Change kinds on lab are back to the defaults.");
  expect(second.output.split("  Allowed now: ").at(-1)).toMatch(/^none\n/);
});

test("/mcp allow: 6 allows everything on that server for this session only; the footer shows it", async () => {
  const { home, project } = await fixture({ casper: { mcpServers: { lab: entry({ FIXTURE_MODE: "access-bad" }) } } });
  const { output, app } = await session(home, project, ["/mcp connect lab", "/mcp allow lab"], ["1", "6"]);
  expect(output).toContain("[mcp] Yes to everything on lab this session: no change there asks you. /mcp writes off ends it.");
  expect(app.allowances!.allowAllOn("lab")).toBe(true);
  expect(app.terminal.badge).toMatch(/^ALLOW ALL: lab · /);
});
