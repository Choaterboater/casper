import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import { approveAllLabel } from "../src/app/safe-choices";
import { gatesConfirmedOff } from "../src/mcp/access";
import { discoverMCPConfiguration } from "../src/mcp/config";
import type { MCPManager } from "../src/mcp/manager";
import { saveLogin } from "../src/mcp/network/logins";
import { networkServerEntry } from "../src/mcp/network/server";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeStartOptions, RuntimeTool } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { allowSlowServerStopsOnWindows, fakeServerProgram } from "./support/fake-program";
import { removeTempDir } from "./support/temp-dir";

/**
 * Casper's network server end to end: the real app, manager and broker, with tests/fixtures/fake-network-mcp.ts
 * installed where Casper installs casper-network-mcp. The fake honours --read-only like the real server (changes
 * refused, its troubleshooting list let through) and reports the login's own reach whatever the pin.
 */
allowSlowServerStopsOnWindows();
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

const site = (name: string, id = "s1") => ({ kind: "site", id, name });
const hit = (name: string, kind: string, product: string, label = "write") => ({ name, product, summary: `${name}.`, kind, label });
/** What find_tool knows in these tests (the fake checks a login for names starting mist_, central_ or clearpass_). */
const HITS = [
  hit("mist_update_wlan", "config", "mist"),
  hit("mist_update_site_setting", "config", "mist"),
  hit("mist_bounce_switch_port", "disruptive", "mist", "destructive"),
  hit("mist_update_device", "firmware", "mist"),
  hit("cx_show", "troubleshoot", "central", "diagnostic"),
];
const WLAN = { name: "mist_update_wlan", arguments: { site_id: "s1", wlan_id: "w1", changes: { vlan_id: 30 } } };
const SETTING = { name: "mist_update_site_setting", arguments: { site_id: "s1", changes: { ntp: "192.0.2.10" } } };
const BOUNCE = { name: "mist_bounce_switch_port", arguments: { site_id: "s1", port: "ge-0/0/7" } };

interface Ctx {
  /** The AI calls one of the server's tools; returns what the AI reads back. */
  call: (tool: string, args: Record<string, unknown>) => Promise<string>;
  app: CasperApp;
  manager: () => MCPManager;
  /** The server's arguments at its latest start. */
  serverArgs: () => Promise<string[]>;
}
/** One line typed at the prompt: a command, or a request the AI answers by running `ai`. */
type Step = string | ((ctx: Ctx) => Promise<void>);

async function networkSession(options: {
  reach?: Record<string, unknown>; steps: Step[]; answers?: string[]; interactive?: boolean;
  /** Run the same stand-in from a path that doesn't name casper-network-mcp: matched by its tool list only. */
  lookalike?: boolean;
  /** More of the stand-in's FAKE_* settings. */
  env?: Record<string, string>;
}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-network-e2e-"));
  cleanup.push(() => removeTempDir(root));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  await mkdir(path.join(project, ".casper"), { recursive: true });
  const calls = path.join(root, "calls.log");
  const where = options.lookalike ? path.join(root, "bin/netserver") : networkServerEntry(home).command;
  await mkdir(path.dirname(where), { recursive: true });
  const reach = options.reach ?? { mist: { access: "read-write", can_change: [site("Branch-12")] } };
  const entry = await fakeServerProgram(where, "fake-network-mcp", {
    ...options.env, FAKE_CALLS_FILE: calls, FAKE_REACH: JSON.stringify(reach), FAKE_HITS: JSON.stringify(HITS),
  });
  await mkdir(path.join(home, ".casper"), { recursive: true });
  await writeFile(path.join(home, ".casper/mcp.json"), JSON.stringify({ mcpServers: {
    network: options.lookalike ? { command: entry, args: [], env: {} } : networkServerEntry(home) } }));
  await saveLogin(home, "mist", { MIST_HOST: "https://api.mist.com", MIST_API_TOKEN: "tok_EXAMPLE_0123456789" });
  const log = async () => (await readFile(calls, "utf8").catch(() => "")).split("\n");
  const serverArgs = async () => JSON.parse((await log()).filter((line) => line.startsWith("start ")).at(-1)!.slice("start ".length)) as string[];

  const results: string[] = [];
  const steps = [...options.steps];
  let turn: ((ctx: Ctx) => Promise<void>) | undefined;
  let tools: RuntimeTool[] = [];
  let app!: CasperApp;
  const ctx: Ctx = {
    call: async (tool, args) => {
      const run = tools.find((item) => item.name === "call_capability")!;
      const text = (await run.execute({ id: `mcp:network:${tool}`, arguments: args })).text;
      results.push(text);
      return text;
    },
    get app() { return app; },
    manager: () => app.mcp!,
    serverArgs,
  };
  const runtime: AgentRuntime = {
    async start(start: RuntimeStartOptions) {
      tools = start.tools ?? [];
      return { setTools: (next: RuntimeTool[]) => { tools = next; }, prompt: async () => { const next = turn; turn = undefined; await next?.(ctx); },
        abort: async () => {}, subscribe: () => () => {}, getState: () => ({ cwd: start.cwd, isStreaming: false }) };
    },
    async dispose() {},
  };
  const input = new PassThrough();
  let output = "";
  const answers = [...options.answers ?? []];
  const nextLine = () => {
    const step = steps.shift();
    if (step === undefined) return "/exit";
    if (typeof step === "string") return step;
    turn = step;
    return "please do it";
  };
  app = new CasperApp({
    runtimeFactory: () => runtime, input, sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: () => discoverMCPConfiguration({ projectRoot: project, homeDir: home, platform: "linux" }),
    output: { write: (text) => {
      output += text;
      if (text === "> ") queueMicrotask(() => input.write(`${nextLine()}\n`));
      if (/Type [\d, ]*\d or \d: $/.test(text)) { const answer = answers.shift() ?? "1"; queueMicrotask(() => input.write(`${answer}\n`)); }
    } },
  });
  cleanup.push(() => app.close());
  if (options.interactive === false) {
    await app.runOnce("/mcp connect network", project);
    while (steps.length) await app.runOnce(nextLine(), project);
  } else {
    await app.runOnce("/mcp connect network", project);
    await app.runInteractive();
  }
  const boxes = output.split("Change in ").slice(1).map((part) => `Change in ${part.slice(0, part.search(/Type [\d, ]*\d or \d: /))}`);
  return { output, results, boxes, answersLeft: answers, serverArgs, log, starts: async () => (await log()).filter((line) => line.startsWith("start ")),
    ran: async (name: string) => (await log()).filter((line) => line.startsWith("call invoke_") && line.includes(`"name":"${name}"`)).length };
}

const choiceLines = (box: string) => box.split("\n").filter((line) => /^ {2}\d /.test(line)).map((line) => line.trim().replace(/^\d /, ""));

test("first change: the box names the product and the login's reach; 2 turns writes on and restarts without --read-only", async () => {
  const s = await networkSession({
    answers: ["2"],
    steps: [async (ai) => {
      await ai.call("find_tool", { query: "change the guest wlan vlan" });
      expect(await ai.serverArgs()).toContain("--read-only");
      await ai.call("invoke_tool", WLAN);
    }],
  });
  expect(s.boxes).toHaveLength(1);
  const box = s.boxes[0]!;
  expect(box).toStartWith("Change in Mist: mist update wlan\n");
  expect(box).toContain("Your login can change: Branch-12 site\n");
  expect(choiceLines(box)).toEqual(["No", "Yes, this once", "Yes, for this session", approveAllLabel("Network")]);
  expect(await s.ran("mist_update_wlan")).toBe(1);
  expect(s.results.at(-1)).toContain('"ok":true');
  // The change ran on a start without --read-only; "Yes, this once" pins the server again afterwards.
  const log = await s.log();
  const ranAt = log.findIndex((line) => line.startsWith("call invoke_tool") && line.includes("mist_update_wlan"));
  expect(log.slice(0, ranAt).filter((line) => line.startsWith("start ")).at(-1)).toBe("start []");
  expect(log.filter((line) => line.startsWith("start ")).at(-1)).toBe('start ["--read-only"]');
});

test("setWrites(true) succeeds while connected pinned with a write-capable login", async () => {
  let policyAccess: string | undefined;
  let after: string[] = [];
  await networkSession({
    steps: [async (ai) => {
      expect(await ai.serverArgs()).toContain("--read-only");
      policyAccess = ai.manager().policy("network").access?.state;
      await expect(ai.manager().setWrites("network", true)).resolves.toBeUndefined();
      after = await ai.serverArgs();
    }],
  });
  expect(policyAccess).toBe("read-write");
  expect(after).not.toContain("--read-only");
});

test("after a 3 on a config change, a second config change runs without a box; a port bounce still asks", async () => {
  const s = await networkSession({
    answers: ["3", "1"],
    steps: [async (ai) => {
      await ai.call("find_tool", { query: "wlan vlan, site settings, bounce a port" });
      await ai.call("invoke_tool", WLAN);
      await ai.call("invoke_tool", SETTING);
      await ai.call("invoke_tool", BOUNCE);
    }],
  });
  expect(s.boxes).toHaveLength(2);
  expect(s.boxes[0]).toStartWith("Change in Mist: mist update wlan\n");
  expect(s.boxes[1]).toStartWith("Change in Mist: mist bounce switch port\n");
  expect(choiceLines(s.boxes[1]!)).toEqual(["No", "Yes, this once", approveAllLabel("Network")]);
  expect(await s.ran("mist_update_wlan")).toBe(1);
  expect(await s.ran("mist_update_site_setting")).toBe(1);
  expect(await s.ran("mist_bounce_switch_port")).toBe(0);
  expect(s.results.at(-1)).toContain("you said no");
});

test("a show command runs after one 2 with no restart", async () => {
  const s = await networkSession({
    answers: ["2"],
    steps: [async (ai) => {
      await ai.call("find_tool", { query: "show interfaces" });
      await ai.call("invoke_read_tool", { name: "cx_show", arguments: { command: "show interfaces" } });
    }],
  });
  expect(s.boxes).toHaveLength(1);
  expect(s.boxes[0]).toContain("[diagnostic]");
  // The box names the tool's own product, and shows only that product's reach (Central has no login here).
  expect(s.boxes[0]).toStartWith("Change in Central: cx show\n");
  expect(s.boxes[0]).not.toContain("Your login can change");
  expect(await s.ran("cx_show")).toBe(1);
  expect(await s.starts()).toEqual(['start ["--read-only"]']);
});

test("a disruptive tool asks every time even after 'Yes, for this session'", async () => {
  const s = await networkSession({
    answers: ["3", "2", "2"],
    steps: [async (ai) => {
      await ai.call("find_tool", { query: "wlan vlan, bounce a port" });
      await ai.call("invoke_tool", WLAN);
      await ai.call("invoke_tool", BOUNCE);
      await ai.call("invoke_tool", BOUNCE);
    }],
  });
  expect(s.boxes).toHaveLength(3);
  for (const box of s.boxes.slice(1)) {
    expect(box).toStartWith("Change in Mist: mist bounce switch port\n");
    expect(choiceLines(box)).toEqual(["No", "Yes, this once", approveAllLabel("Network")]);
  }
  expect(await s.ran("mist_bounce_switch_port")).toBe(2);
});

test("a firmware kind from find_tool asks first, even for a name that reads as a config change", async () => {
  const s = await networkSession({
    answers: ["3", "1"],
    steps: [async (ai) => {
      await ai.call("find_tool", { query: "wlan vlan, device update" });
      await ai.call("invoke_tool", WLAN);
      await ai.call("invoke_tool", { name: "mist_update_device", arguments: { device_id: "d1" } });
    }],
  });
  expect(s.output).toContain("Firmware changes are off by default on Network.");
  expect(await s.ran("mist_update_device")).toBe(0);
});

test("ctrl+o restarts it read-only and ends the grant", async () => {
  let pinned: string[] = [];
  const s = await networkSession({
    answers: ["3", "1"],
    steps: [async (ai) => {
      await ai.call("find_tool", { query: "wlan vlan, site settings" });
      await ai.call("invoke_tool", WLAN);
      expect(await ai.serverArgs()).not.toContain("--read-only");
      // ctrl+o
      expect(ai.app["revertWrites"]()).toBe(true);
      // The server restarts with its pin once its calls finish.
      const ready = () => ai.manager().status().find((entry) => entry.name === "network")?.state === "ready";
      for (let i = 0; i < 100 && !(ready() && (await ai.serverArgs()).includes("--read-only")); i++) await new Promise((resolve) => setTimeout(resolve, 30));
      pinned = await ai.serverArgs();
      await ai.call("invoke_tool", SETTING);
    }],
  });
  expect(pinned).toContain("--read-only");
  expect(s.output).toContain("[mcp] Writes off for network. Every change asks you again.");
  expect(s.boxes).toHaveLength(2);
  expect(s.boxes[1]).toStartWith("Change in Mist: mist update site setting\n");
  expect(await s.ran("mist_update_site_setting")).toBe(0);
});

test("a read-only login hides changes", async () => {
  const s = await networkSession({
    reach: { mist: { access: "read-only" } },
    steps: ["/mcp detail", async (ai) => {
      await ai.call("find_tool", { query: "change the guest wlan vlan" });
      await ai.call("invoke_tool", WLAN);
    }],
  });
  expect(s.boxes).toHaveLength(0);
  expect(s.results.at(-1)).toContain("Not executed");
  expect(s.results.at(-1)).toContain("read-only");
  expect(s.output).toContain("network [stdio; ready] 4 tools · preset: casper-network-mcp · writes off · login: read-only (checked)\n");
});

test("one-shot: a change is not executed", async () => {
  const s = await networkSession({
    interactive: false,
    steps: [async (ai) => {
      await ai.call("find_tool", { query: "change the guest wlan vlan" });
      await ai.call("invoke_tool", WLAN);
    }],
  });
  expect(s.results.at(-1)).toContain("Not executed (needs your approval, and this run cannot ask)");
  expect(await s.ran("mist_update_wlan")).toBe(0);
  expect(s.boxes).toHaveLength(0);
});

test("/mcp says the read-only pin was confirmed", async () => {
  let confirmed: boolean | undefined;
  const s = await networkSession({
    steps: [async (ai) => { confirmed = gatesConfirmedOff(ai.manager().policy("network").access); }, "/mcp detail"],
  });
  expect(confirmed).toBe(true);
  expect(s.output).toContain("preset: casper-network-mcp (read-only pinned: --read-only)");
  expect(s.output).not.toContain("read-only pins sent, not confirmed");
});

test("review: a tool find_tool never named asks every time, even after 'Yes, for this session'", async () => {
  // central_replaceimage_v1 is a firmware change on the real server, but its name reads as config and the AI never searched for it.
  const s = await networkSession({
    answers: ["3", "1", "1"],
    steps: [async (ai) => {
      await ai.call("find_tool", { query: "change the guest wlan vlan" });
      await ai.call("invoke_tool", WLAN);
      await ai.call("invoke_tool", { name: "central_replaceimage_v1", arguments: { serial: "SN1" } });
      await ai.call("invoke_tool", { name: "mist_update_org_inventory_assignment", arguments: { org_id: "o1" } });
    }],
  });
  expect(s.boxes).toHaveLength(3);
  for (const box of s.boxes.slice(1)) expect(choiceLines(box)).toEqual(["No", "Yes, this once", approveAllLabel("Network")]);
  expect(await s.ran("central_replaceimage_v1")).toBe(0);
  expect(await s.ran("mist_update_org_inventory_assignment")).toBe(0);
});

test("review: a look-alike matched only by its tool list keeps invoke_tool destructive", async () => {
  const s = await networkSession({
    lookalike: true, answers: ["1"],
    steps: [async (ai) => {
      expect(ai.manager().policy("network").match).toMatchObject({ by: "tools" });
      await ai.call("find_tool", { query: "change the guest wlan vlan" });
      await ai.call("invoke_tool", WLAN);
    }],
  });
  expect(s.boxes).toHaveLength(1);
  expect(s.boxes[0]).toContain("[destructive]");
  expect(choiceLines(s.boxes[0]!)).not.toContain("Yes, for this session");
});

test("review: a batch, an unclear call, or an invoke_tool the server marks destructive offers no session answer", async () => {
  const batch = await networkSession({
    answers: ["1", "1"],
    steps: [async (ai) => {
      await ai.call("find_tool", { query: "wlan vlan, site settings" });
      await ai.call("invoke_tool", { ...WLAN, calls: [SETTING] });
      await ai.call("invoke_tool", { name: "" });
    }],
  });
  expect(batch.boxes).toHaveLength(2);
  for (const box of batch.boxes) expect(choiceLines(box)).not.toContain("Yes, for this session");
  const marked = await networkSession({
    env: { FAKE_INVOKE_DESTRUCTIVE: "1" }, answers: ["1"],
    steps: [async (ai) => {
      await ai.call("find_tool", { query: "change the guest wlan vlan" });
      await ai.call("invoke_tool", WLAN);
    }],
  });
  expect(marked.boxes).toHaveLength(1);
  expect(choiceLines(marked.boxes[0]!)).not.toContain("Yes, for this session");
});

test("without a find_tool hit, the box takes the product from the tool's name, and shows no other product's reach", async () => {
  const s = await networkSession({
    answers: ["1", "1"],
    reach: { mist: { access: "read-write", can_change: [site("Branch-12")] } },
    steps: [async (ai) => {
      await ai.call("invoke_tool", { name: "clearpass_update_role", arguments: { id: 1 } });
      await ai.call("invoke_tool", { name: "set_banner", arguments: { text: "hi" } });
    }],
  });
  expect(s.boxes).toHaveLength(2);
  expect(s.boxes[0]).toStartWith("Change in ClearPass: clearpass update role\n");
  expect(s.boxes[0]).not.toContain("Your login can change");
  // A tool of no known product on a server with more than one: the reach is unknown, so no line.
  expect(s.boxes[1]).not.toContain("Your login can change");
});
