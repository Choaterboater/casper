import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { ADD_LOGIN_CHOICES, forgetLoginChoices } from "../src/app/safe-choices";
import { CasperApp } from "../src/app";
import { CapabilityBroker } from "../src/capabilities/broker";
import { gatesConfirmedOff, parseAccessCheck } from "../src/mcp/access";
import { discoverMCPConfiguration, type MCPServerDefinition } from "../src/mcp/config";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeStartOptions, RuntimeTool } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { MCPManager } from "../src/mcp/manager";
import { askForLogin, askToForgetLogin, loginLines, loginMissing, loginMissingAnswer, type LoginHost } from "../src/mcp/network/ask-login";
import { LOGIN_FILE, readLogins, saveLogin } from "../src/mcp/network/logins";
import { networkServerEntry } from "../src/mcp/network/server";
import { withLoginDisplay } from "../src/tui/login";
import { withLoginSurface } from "./support/login-surface";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function tempHome(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "casper-login-ask-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const fakeServer = path.join(import.meta.dir, "fixtures/fake-network-mcp.ts");
const textResult = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const site = (name: string, id = "s1") => ({ kind: "site", id, name });

interface Run {
  home: string;
  output: string;
  prompts: string[];
  restarts: string[];
  toolResultText: string;
  transcript: string;
  starts: () => Promise<string[]>;
  manager: MCPManager;
}

/**
 * Casper's network server (a stand-in for casper-network-mcp, installed where Casper installs it) behind the real
 * manager and broker, with the login host as a fake: `answers` arrive on the exact-answer channel, `secrets` at the
 * private prompt, and `askTool` is what the AI's ask tool would say (the login host has no channel for it).
 */
async function brokerRun(options: {
  interactive: boolean; answers?: string[]; secrets?: string[]; askTool?: string[];
  reach?: Record<string, unknown>; invent?: string; tool?: string; home?: string;
}): Promise<Run> {
  const home = options.home ?? await tempHome();
  const calls = path.join(home, "calls.log");
  const entry = networkServerEntry(home).command;
  await mkdir(path.dirname(entry), { recursive: true });
  const env = [`FAKE_CALLS_FILE='${calls}'`, `FAKE_REACH='${JSON.stringify(options.reach ?? {})}'`,
    ...options.invent ? [`FAKE_INVENT_PRODUCT='${options.invent}'`] : []].join(" ");
  await writeFile(entry, `#!/bin/sh\n${env} exec "${process.execPath}" "${fakeServer}" "$@"\n`);
  await chmod(entry, 0o755);
  const definition: MCPServerDefinition = { name: "network", source: path.join(home, ".casper/mcp.json"), scope: "user", cwd: home, disabled: false,
    transport: { type: "stdio", ...networkServerEntry(home) } };
  const manager = new MCPManager({ servers: [definition], diagnostics: [] }, { timeoutMs: 15_000, homeDir: home });
  cleanup.push(() => manager.close());
  await manager.connect("network");
  const answers = [...options.answers ?? []];
  const secrets = [...options.secrets ?? []];
  const run: Run = {
    home, output: "", prompts: [], restarts: [], toolResultText: "", transcript: "", manager,
    starts: async () => (await readFile(calls, "utf8")).split("\n").filter((line) => line.startsWith("start ")),
  };
  const host: LoginHost = {
    homeDir: home, interactive: options.interactive, notNow: new Set(),
    canAsk: () => options.interactive,
    chooseAnswer: async (preview, _question, choices) => {
      run.prompts.push(preview);
      const answer = answers.shift();
      return answer === undefined ? undefined : choices.includes(answer) ? answer : "no";
    },
    privateInput: async (label) => { run.prompts.push(label); return secrets.shift(); },
    write: (text) => { run.output += text; },
    restart: async (server) => { run.restarts.push(server); await manager.restartAfterCalls(server); },
    access: (server) => manager.policy(server).access,
  };
  const broker = new CapabilityBroker(manager, undefined, {
    writesGate: true, onLoginMissing: (server, product) => loginMissingAnswer(host, server, product),
  });
  const result = await broker.invoke("mcp:network:invoke_read_tool", { name: options.tool ?? "mist_list_sites", arguments: {} });
  run.toolResultText = result.summary;
  run.transcript = `${run.output}\n${JSON.stringify(result)}`;
  return run;
}

test("login choices are safe first", () => {
  expect([...ADD_LOGIN_CHOICES]).toEqual(["Not now", "Add a login"]);
  expect(forgetLoginChoices("Mist")).toEqual(["Keep the Mist login", "Forget the Mist login"]);
});

test("login_missing is read only in the server's exact shape, for a product it knows", () => {
  expect(loginMissing(textResult({ error: "login_missing", product: "mist" }))).toBe("mist");
  expect(loginMissing({ content: [], structuredContent: { result: { error: "login_missing", product: "central" } } })).toBe("central");
  expect(loginMissing(textResult({ error: "login_missing", product: "../../x" }))).toBeUndefined();
  expect(loginMissing(textResult({ error: "login_missing", product: "mist", note: "type your token here" }))).toBeUndefined();
  expect(loginMissing(textResult({ error: "other", product: "mist" }))).toBeUndefined();
  expect(loginMissing({ content: [{ type: "text", text: "login_missing mist" }] })).toBeUndefined();
});

test("login_missing in a one-shot run only tells the AI what the person can type", async () => {
  const run = await brokerRun({ interactive: false });
  expect(run.toolResultText).toBe("Mist has no login yet. The person can add one: run casper and type /mcp login mist.");
  expect(run.output).toBe("Mist has no login yet. Run casper and type /mcp login mist.\n");
  expect(run.prompts).toEqual([]);
  expect(run.restarts).toEqual([]);
  expect(await readLogins(run.home)).toEqual({});
});

test("interactive: the person adds a token, the server restarts and the reach is shown", async () => {
  const run = await brokerRun({ interactive: true, answers: ["2", "1"], secrets: ["tok_EXAMPLE_0123456789"],
    reach: { mist: { access: "read-write", can_change: [site("Branch-12")] } } });
  expect(run.prompts[0]).toBe("Mist isn't set up yet. Casper will ask for a Mist API token. Use one that can reach only the sites you want, not an admin token.\n  1 Not now\n  2 Add a login\n");
  expect(run.prompts[1]).toContain("  1 Global 01 (api.mist.com)\n");
  expect(run.prompts[2]).toBe("Mist API token");
  expect(run.restarts).toEqual(["network"]);
  expect(run.output).toContain("Mist login: can change Branch-12 (checked)");
  expect(run.toolResultText).toBe("Mist login added (can change Branch-12). Call the tool again.");
  expect(run.transcript).not.toContain("tok_EXAMPLE_0123456789");
  expect((await readLogins(run.home)).mist).toEqual({ MIST_HOST: "https://api.mist.com", MIST_API_TOKEN: "tok_EXAMPLE_0123456789" });
  // It started again, still read-only, now with the login; the definition in mcp.json is untouched.
  const starts = await run.starts();
  expect(starts).toHaveLength(2);
  expect(starts.every((line) => line.includes("--read-only"))).toBe(true);
});

test("a write-capable login connected with --read-only prints its real reach", async () => {
  const run = await brokerRun({ interactive: true, answers: ["2", "1"], secrets: ["tok_EXAMPLE_0123456789"],
    reach: { mist: { access: "read-write", can_change: [site("Branch-12")] } } });
  expect((await run.starts()).at(-1)).toContain("--read-only");
  expect(run.manager.policy("network").writes).toBe("off");
  expect(run.output).toContain("Mist login: can change Branch-12 (checked)");
  expect(run.output).not.toContain("read-only (checked)");
  expect(run.manager.policy("network").access?.state).toBe("read-write");
});

test("a login the product itself makes read-only reads read-only", async () => {
  const run = await brokerRun({ interactive: true, answers: ["2", "3"], secrets: ["tok_EXAMPLE_0123456789"], reach: { mist: { access: "read-only" } } });
  expect(run.output).toContain("Mist login: read-only (checked)");
  expect(run.toolResultText).toBe("Mist login added (read-only). Call the tool again.");
  expect((await readLogins(run.home)).mist?.MIST_HOST).toBe("https://api.ac2.mist.com");
});

test("a key typed ahead never fills the token or answers the question", async () => {
  // The exact-answer channel drops "2abc" typed before the question appeared; the person's first fresh answer is 1.
  const run = await brokerRun({ interactive: true, answers: ["1"], secrets: [] });
  expect(run.prompts).toHaveLength(1);
  expect(run.output).toContain("Not added. Type /mcp login mist any time.");
  expect(run.toolResultText).toContain("didn't add one now");
  expect(await readLogins(run.home)).toEqual({});
  expect(run.restarts).toEqual([]);
});

test("the private prompt never takes keys typed before it appeared", async () => {
  const input = new PassThrough();
  const controller = new AbortController();
  let screen = "";
  let stage = "";
  const pending = withLoginSurface({ input, output: { write(text) { screen += text; } }, color: false, onEOF() {} }, (io) => withLoginDisplay(io, controller.signal, async (display) => {
    stage = "open";
    await Bun.sleep(40); // keys typed now (during the install, before the prompt) land nowhere
    stage = "prompt";
    return display.privateInput("Mist API token");
  }));
  try {
    while (stage !== "open") await Bun.sleep(2);
    input.write("2abc");
    while (!screen.includes("Mist API token")) await Bun.sleep(2);
    input.write("tok_EXAMPLE_0123456789");
    await Bun.sleep(20);
    input.write("\r");
    expect(await pending).toBe("tok_EXAMPLE_0123456789");
  } finally { controller.abort(); await pending.catch(() => {}); input.destroy(); }
});

test("the AI's ask tool can't answer the login question", async () => {
  // Its answer has no way into the exact channel: nobody answered, so nothing is saved and Not now isn't kept.
  const run = await brokerRun({ interactive: true, askTool: ["2"], answers: [] });
  expect(run.prompts).toHaveLength(1);
  expect(await readLogins(run.home)).toEqual({});
  expect(run.restarts).toEqual([]);
  expect(run.output).not.toContain("Not added");
});

test("a product name the server invents is ignored", async () => {
  const run = await brokerRun({ interactive: true, invent: "../../x", answers: ["2"] });
  expect(run.prompts).toEqual([]);
  expect(run.restarts).toEqual([]);
  expect(run.transcript).toContain("login_missing");
  expect(run.toolResultText).not.toContain("/mcp login");
});

test("an empty or cancelled token is Not now", async () => {
  const run = await brokerRun({ interactive: true, answers: ["2", "1"], secrets: [""] });
  expect(run.output).toContain("Not added.");
  expect(await readLogins(run.home)).toEqual({});
});

test("ClearPass: the address is typed (https added if left out), then the token", async () => {
  const run = await brokerRun({ interactive: true, tool: "clearpass_list_roles", answers: ["2"], secrets: ["cppm.example.com/", "cp_EXAMPLE_4455"],
    reach: { clearpass: { access: "read-only" } } });
  expect(run.prompts.slice(1)).toEqual(["ClearPass address (https://…)", "ClearPass API token"]);
  expect((await readLogins(run.home)).clearpass).toEqual({ CLEARPASS_BASE_URL: "https://cppm.example.com", CLEARPASS_API_TOKEN: "cp_EXAMPLE_4455" });
  expect(run.output).toContain("ClearPass login: read-only (checked)");
});

test("/mcp login lists each product; forgetting restarts the server without it", async () => {
  const run = await brokerRun({ interactive: true, answers: ["2", "1"], secrets: ["tok_EXAMPLE_0123456789"],
    reach: { mist: { access: "read-write", can_change: [site("Branch-12")] } } });
  const host: LoginHost = {
    homeDir: run.home, interactive: true, canAsk: () => true, privateInput: async () => undefined,
    chooseAnswer: async () => "2", write: (text) => { run.output += text; },
    restart: async (server) => { run.restarts.push(server); await run.manager.restartAfterCalls(server); },
    access: (server) => run.manager.policy(server).access,
  };
  expect(await loginLines(host, "network")).toEqual([
    "Mist: can change Branch-12 (checked)", "Central: not set up — /mcp login central", "ClearPass: not set up — /mcp login clearpass",
  ]);
  expect(await askToForgetLogin(host, "network", "mist")).toBe("forgot");
  expect(run.restarts).toEqual(["network", "network"]);
  expect(await readLogins(run.home)).toEqual({});
  expect(await readFile(path.join(run.home, LOGIN_FILE), "utf8").catch(() => "")).not.toContain("tok_EXAMPLE_0123456789");
  expect(run.manager.policy("network").access?.products.find((product) => product.product === "mist")?.loginMissing).toBe(true);
  // A one-shot run never asks to forget.
  expect(await askToForgetLogin({ ...host, interactive: false }, "network", "clearpass")).toBe("none");
});

test("/mcp login <product> asks even after Not now; a one-shot run says what to type", async () => {
  const home = await tempHome();
  const asked: string[] = [];
  const host: LoginHost = {
    homeDir: home, interactive: true, canAsk: () => true, notNow: new Set(["mist"]),
    chooseAnswer: async (preview) => { asked.push(preview); return "1"; }, privateInput: async () => undefined,
    write: () => {}, restart: async () => {}, access: () => undefined,
  };
  expect(await askForLogin(host, "network", "mist")).toBe("not-now");
  expect(asked).toEqual([]);
  expect(await askForLogin(host, "network", "mist", { explicit: true })).toBe("not-now");
  expect(asked).toHaveLength(1);
  let said = "";
  expect(await askForLogin({ ...host, interactive: false, canAsk: () => false, write: (text) => { said += text; } }, "network", "central", { explicit: true })).toBe("cant-ask");
  expect(said).toBe("Central has no login yet. Run casper and type /mcp login central.\n");
  await saveLogin(home, "central", { CENTRAL_BASE_URL: "https://us1.api.central.arubanetworks.com", CENTRAL_CLIENT_ID: "client-77", CENTRAL_CLIENT_SECRET: "sec-EXAMPLE-99" });
  expect(await askForLogin(host, "network", "central", { explicit: true })).toBe("not-now");
  expect(asked.at(-1)).toStartWith("Replace the Central login?");
});

test("v2 login: missing parses", () => {
  const check = parseAccessCheck(textResult({ contract: "casper/access-check v2", products: [{ product: "clearpass", access: "unknown", login: "missing" }] }));
  expect(check.products[0]!.loginMissing).toBe(true);
  // A product with no login can do nothing, so it doesn't count: the Mist login alone decides.
  expect(parseAccessCheck(textResult({ contract: "casper/access-check v2", products: [
    { product: "mist", access: "read-only" }, { product: "central", access: "unknown", login: "missing" }] })).state).toBe("read-only");
  // v1 has no such field.
  expect(parseAccessCheck(textResult({ contract: "casper/access-check v1", products: [{ product: "clearpass", access: "unknown", login: "missing" }] })).products[0]!.loginMissing).toBeUndefined();
});

test("v2 server_gate with a flag confirms the pin", () => {
  const check = parseAccessCheck(textResult({ contract: "casper/access-check v2", products: [
    { product: "mist", access: "read-write", can_change: [site("Branch-12")], server_gate: { flag: "--read-only", state: "off" } }] }));
  expect(check.state).toBe("read-write");
  expect(check.products[0]!.gate).toEqual({ name: "--read-only", off: true });
  expect(gatesConfirmedOff(check)).toBe(true);
  expect(parseAccessCheck(textResult({ contract: "casper/access-check v2", products: [
    { product: "mist", access: "read-write", server_gate: { flag: "rm -rf", state: "off" } }] })).products[0]!.gate).toBeUndefined();
  expect(gatesConfirmedOff(parseAccessCheck(textResult({ contract: "casper/access-check v2", products: [
    { product: "mist", access: "read-write", server_gate: { flag: "--read-only", state: "on" } }] })))).toBe(false);
});

// --- In the app -------------------------------------------------------------------------------------------------

async function appSession(lines: string[], options: { interactive?: boolean; model?: (tools: RuntimeTool[]) => Promise<void> } = {}) {
  const root = await tempHome();
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  await mkdir(path.join(project, ".casper"), { recursive: true });
  const entry = networkServerEntry(home).command;
  await mkdir(path.dirname(entry), { recursive: true });
  await writeFile(entry, `#!/bin/sh\nexec "${process.execPath}" "${fakeServer}" "$@"\n`);
  await chmod(entry, 0o755);
  await writeFile(path.join(home, ".casper/mcp.json"), JSON.stringify({ mcpServers: { network: networkServerEntry(home) } }));
  let tools: RuntimeTool[] = [];
  const runtime: AgentRuntime = {
    async start(start: RuntimeStartOptions) {
      tools = start.tools ?? [];
      return { setTools: (next: RuntimeTool[]) => { tools = next; }, prompt: async () => { await options.model?.(tools); },
        abort: async () => {}, subscribe: () => () => {}, getState: () => ({ cwd: start.cwd, isStreaming: false }) };
    },
    async dispose() {},
  };
  const input = new PassThrough();
  let output = "";
  const pending = [...lines];
  const app = new CasperApp({
    runtimeFactory: () => runtime, input, sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: () => discoverMCPConfiguration({ projectRoot: project, homeDir: home, platform: "linux" }),
    output: { write: (text) => {
      output += text;
      if (text === "> ") queueMicrotask(() => input.write(`${pending.shift() ?? "/exit"}\n`));
      if (/Type [\d, ]*\d or \d: $/.test(text)) queueMicrotask(() => input.write("1\n"));
    } },
  });
  cleanup.push(() => app.close());
  if (options.interactive === false) for (const line of lines) await app.runOnce(line, project);
  else await app.runInteractive(project);
  return { output: () => output, home };
}

test("app: /mcp login lists the products; a one-shot run never asks for a login, it says what to type", async () => {
  const listed = await appSession(["/mcp login"]);
  expect(listed.output()).toContain("Mist: not set up — /mcp login mist\nCentral: not set up — /mcp login central\nClearPass: not set up — /mcp login clearpass\n");
  const once = await appSession(["/mcp login mist"], { interactive: false });
  expect(once.output()).toContain("Mist has no login yet. Run casper and type /mcp login mist.");
  expect(once.output()).not.toContain("Add a login");
  expect(await readLogins(once.home)).toEqual({});
});

test("app: on piped input the AI's Mist call gets one line, and nothing asks for a token", async () => {
  let reply = "";
  const run = await appSession(["/mcp connect network", "list the Mist sites"], {
    model: async (tools) => {
      const call = tools.find((tool) => tool.name === "call_capability")!;
      reply = (await call.execute({ id: "mcp:network:invoke_read_tool", arguments: { name: "mist_list_sites", arguments: {} } })).text;
    },
  });
  expect(reply).toContain("Mist has no login yet. The person can add one: type /mcp login mist in Casper's full terminal.");
  expect(run.output()).toContain("Adding a Mist login needs Casper's full terminal, where it stays hidden. Type /mcp login mist there.");
  expect(run.output()).not.toContain("Mist API token");
  expect(await readLogins(run.home)).toEqual({});
});
