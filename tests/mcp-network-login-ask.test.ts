import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { askForLogin, askToForgetLogin, loginExpired, loginLines, loginMissing, loginMissingAnswer, type LoginHost } from "../src/mcp/network/ask-login";
import { LOGIN_FILE, readLogins, saveLogin, type NetworkProduct } from "../src/mcp/network/logins";
import { networkServerEntry } from "../src/mcp/network/server";
import { withLoginDisplay } from "../src/tui/login";
import { allowSlowServerStopsOnWindows, fakeServerProgram } from "./support/fake-program";
import { withLoginSurface } from "./support/login-surface";

allowSlowServerStopsOnWindows();
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function tempHome(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "casper-login-ask-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
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
  /** The products said Not now to in this session. */
  notNow: Set<string>;
}

/**
 * Casper's network server (a stand-in for casper-network-mcp, installed where Casper installs it) behind the real
 * manager and broker, with the login host as a fake: `answers` arrive on the exact-answer channel, `secrets` at the
 * private prompt. `scope: "project"` runs it as a project's server; `call` is the AI's call (a Mist read by default).
 */
async function brokerRun(options: {
  interactive: boolean; answers?: string[]; secrets?: string[];
  reach?: Record<string, unknown>; invent?: string; tool?: string; home?: string; env?: Record<string, string>;
  scope?: "user" | "project"; call?: { id: string; arguments: Record<string, unknown> };
  /** Run the same stand-in from a path that doesn't name casper-network-mcp: matched by its tool list only. */
  lookalike?: boolean;
}): Promise<Run> {
  const home = options.home ?? await tempHome();
  const calls = path.join(home, "calls.log");
  const where = options.lookalike ? path.join(home, "bin/netserver") : networkServerEntry(home).command;
  await mkdir(path.dirname(where), { recursive: true });
  const entry = await fakeServerProgram(where, "fake-network-mcp", {
    FAKE_CALLS_FILE: calls, FAKE_REACH: JSON.stringify(options.reach ?? {}),
    ...options.invent ? { FAKE_INVENT_PRODUCT: options.invent } : {},
    ...options.env,
  });
  const definition: MCPServerDefinition = { name: "network", source: path.join(home, ".casper/mcp.json"), scope: options.scope ?? "user", cwd: home, disabled: false,
    transport: { type: "stdio", ...networkServerEntry(home), command: entry } };
  const manager = new MCPManager({ servers: [definition], diagnostics: [] }, { timeoutMs: 15_000, homeDir: home });
  cleanup.push(() => manager.close());
  await manager.connect("network");
  const answers = [...options.answers ?? []];
  const secrets = [...options.secrets ?? []];
  const notNow = new Set<NetworkProduct>();
  const run: Run = {
    home, output: "", prompts: [], restarts: [], toolResultText: "", transcript: "", manager, notNow,
    starts: async () => (await readFile(calls, "utf8")).split("\n").filter((line) => line.startsWith("start ")),
  };
  const host: LoginHost = {
    homeDir: home, interactive: options.interactive, notNow,
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
    writesGate: true, onLoginMissing: (server, product, _signal, trouble) => loginMissingAnswer(host, server, product, trouble),
  });
  const result = options.call ? await broker.invoke(options.call.id, options.call.arguments)
    : await broker.invoke("mcp:network:invoke_read_tool", { name: options.tool ?? "mist_list_sites", arguments: {} });
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

test("1 Not now adds nothing and doesn't restart the server", async () => {
  const run = await brokerRun({ interactive: true, answers: ["1"], secrets: [] });
  expect(run.prompts).toHaveLength(1);
  // Kept for the session, per product: the AI's next Mist call doesn't ask again.
  expect([...run.notNow]).toEqual(["mist"]);
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

test("review: a project's casper-network-mcp never gets the login question; login_missing is an ordinary result", async () => {
  const run = await brokerRun({ interactive: true, scope: "project", answers: ["2"], secrets: ["tok_EXAMPLE_0123456789"] });
  expect(run.prompts).toEqual([]);
  expect(run.restarts).toEqual([]);
  expect(await readLogins(run.home)).toEqual({});
  expect(run.transcript).toContain("login_missing");
  expect(run.toolResultText).not.toContain("Mist login added");
});

test("review: when the AI calls access_check first, it is told Casper asks for missing logins", async () => {
  const home = await tempHome();
  await saveLogin(home, "mist", { MIST_HOST: "https://api.mist.com", MIST_API_TOKEN: "tok_EXAMPLE_0123456789" });
  const run = await brokerRun({ interactive: true, home, call: { id: "mcp:network:access_check", arguments: {} }, reach: { mist: { access: "read-write" } } });
  expect(run.prompts).toEqual([]);
  expect(run.toolResultText).toContain("Central and ClearPass have no login yet. Call one of their tools and Casper asks the person for it (or they type /mcp login <product>). Don't ask for a login in chat.");
  // A project's server never gets the logins, so it gets no such line either.
  const project = await brokerRun({ interactive: true, scope: "project", call: { id: "mcp:network:access_check", arguments: {} } });
  expect(project.toolResultText).not.toContain("no login yet");
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
  // Nothing to forget says so.
  expect(await askToForgetLogin({ ...host, interactive: false }, "network", "clearpass")).toBe("none");
  // A one-shot run never asks to forget a saved login: it says what to type and keeps it.
  const saved = { CLEARPASS_BASE_URL: "https://cppm.example.com", CLEARPASS_API_TOKEN: "cp_EXAMPLE_4455" };
  await saveLogin(run.home, "clearpass", saved);
  let asked = 0;
  let said = "";
  const once: LoginHost = { ...host, interactive: false, chooseAnswer: async () => { asked++; return "2"; }, write: (text) => { said += text; } };
  expect(await askToForgetLogin(once, "network", "clearpass")).toBe("cant-ask");
  expect(said).toBe("Type /mcp login clearpass forget in the terminal.\n");
  expect(asked).toBe(0);
  expect((await readLogins(run.home)).clearpass).toEqual(saved);
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

async function appSession(lines: string[], options: {
  interactive?: boolean; model?: (tools: RuntimeTool[]) => Promise<void>; answers?: string[]; onApp?: (app: CasperApp) => void;
} = {}) {
  const root = await tempHome();
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  await mkdir(path.join(project, ".casper"), { recursive: true });
  const entry = networkServerEntry(home).command;
  await mkdir(path.dirname(entry), { recursive: true });
  await fakeServerProgram(entry, "fake-network-mcp");
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
  const answers = [...options.answers ?? []];
  const app = new CasperApp({
    runtimeFactory: () => runtime, input, sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: () => discoverMCPConfiguration({ projectRoot: project, homeDir: home, platform: "linux" }),
    output: { write: (text) => {
      output += text;
      if (text === "> ") queueMicrotask(() => input.write(`${pending.shift() ?? "/exit"}\n`));
      if (/Type [\d, ]*\d or \d: $/.test(text)) queueMicrotask(() => input.write(`${answers.shift() ?? "1"}\n`));
    } },
  });
  cleanup.push(() => app.close());
  options.onApp?.(app);
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

test("app: a 2 typed before the login question never answers it, and the question never goes through the AI's ask channel", async () => {
  let asks = 0;
  let privatePrompts = 0;
  const run = await appSession(["/mcp connect network", "list the Mist sites\n2abc"], {
    answers: ["1", "1"],
    onApp: (app) => {
      // Piped input has no private prompt; this one stands in for Casper's full terminal and counts its use.
      Object.assign(app.terminal, { exclusiveHost: () => ({ run: async () => { privatePrompts++; return undefined; } }) });
      const ask = app.terminal.ask.bind(app.terminal);
      app.terminal.ask = (...args: Parameters<typeof ask>) => { asks++; return ask(...args); };
    },
    model: async (tools) => {
      const call = tools.find((tool) => tool.name === "call_capability")!;
      await call.execute({ id: "mcp:network:invoke_read_tool", arguments: { name: "mist_list_sites", arguments: {} } });
    },
  });
  expect(run.output()).toContain("Mist isn't set up yet.");
  expect(run.output()).toContain("[input] Discarded 1 line(s) entered before this question appeared.");
  expect(run.output()).toContain("Not added. Type /mcp login mist any time.");
  expect(privatePrompts).toBe(0);
  expect(asks).toBe(0);
  expect(await readLogins(run.home)).toEqual({});
});

test("the Central question says it is new Central (GreenLake) only for now", async () => {
  const run = await brokerRun({ interactive: true, tool: "central_list_sites", answers: ["1"] });
  expect(run.prompts[0]).toBe("Central isn't set up yet. Casper will ask for a Central API client ID and secret (new Central, through GreenLake, only for now; classic Central logins don't work yet). Use a client with only the access you need, not an admin one.\n  1 Not now\n  2 Add a login\n");
});

test("login_expired, or the product's own 401 for a tool of that product, reads as a login that stopped working", () => {
  expect(loginExpired(textResult({ error: "login_expired", product: "clearpass" }))).toBe("clearpass");
  expect(loginExpired(textResult({ error: "login_expired", product: "clearpass", note: "x" }))).toBeUndefined();
  expect(loginExpired(textResult({ error: "login_expired", product: "../x" }))).toBeUndefined();
  // casper-network-mcp 0.1.0's ApiError.as_error() for the product's 401.
  const url = "https://cppm.example.com/api/endpoint";
  const answered = (status: unknown) => ({ error: `ClearPass answered ${String(status)} to GET ${url}: invalid_token`, status, detail: { error: "invalid_token" }, request_id: "r-1", url });
  expect(loginExpired(textResult(answered(401)), "clearpass")).toBe("clearpass");
  expect(loginExpired({ content: [], structuredContent: { result: answered(401) } }, "clearpass")).toBe("clearpass");
  expect(loginExpired(textResult({ error: "ClearPass answered 401", status: 401 }), "clearpass")).toBe("clearpass");
  // A 401 needs the tool's product, a number status and only as_error()'s keys; any other status is an ordinary error.
  expect(loginExpired(textResult(answered(401)))).toBeUndefined();
  expect(loginExpired(textResult(answered(403)), "clearpass")).toBeUndefined();
  expect(loginExpired(textResult(answered("401")), "clearpass")).toBeUndefined();
  expect(loginExpired(textResult({ ...answered(401), rows: [] }), "clearpass")).toBeUndefined();
  expect(loginExpired(textResult({ status: 401 }), "clearpass")).toBeUndefined();
  expect(loginExpired(textResult({ error: "login_missing", product: "mist" }), "mist")).toBeUndefined();
});

const CLEARPASS_LOGIN = { CLEARPASS_BASE_URL: "https://cppm.example.com", CLEARPASS_API_TOKEN: "cp_OLD_EXAMPLE_1" };

async function replacesTurnedDownLogin(env: Record<string, string>): Promise<void> {
  const home = await tempHome();
  await saveLogin(home, "clearpass", CLEARPASS_LOGIN);
  const run = await brokerRun({ interactive: true, home, env, tool: "clearpass_list_roles", answers: ["2"], secrets: ["cppm.example.com", "cp_NEW_EXAMPLE_2"],
    reach: { clearpass: { access: "read-only" } } });
  expect(run.prompts[0]).toBe("The ClearPass login didn't work (ClearPass turned it down; it may have expired). Replace it? Casper will ask for a ClearPass API token. Use one with only the access you need, not an admin one.\n  1 Not now\n  2 Replace the login\n");
  expect((await readLogins(run.home)).clearpass).toEqual({ CLEARPASS_BASE_URL: "https://cppm.example.com", CLEARPASS_API_TOKEN: "cp_NEW_EXAMPLE_2" });
  expect(run.restarts).toEqual(["network"]);
  expect(run.toolResultText).toBe("ClearPass login replaced (read-only). Call the tool again.");
  expect(run.transcript).not.toContain("cp_NEW_EXAMPLE_2");
}

test("a saved login the product no longer takes (login_expired) brings up the replace box; 2 replaces it", () => replacesTurnedDownLogin({ FAKE_EXPIRED: "clearpass" }));
test("a saved login the product no longer takes (an HTTP 401) brings up the replace box; 2 replaces it", () => replacesTurnedDownLogin({ FAKE_401: "clearpass" }));

test("Not now on the replace box keeps the old login and tells the AI not to ask in chat; a one-shot run says what to type", async () => {
  const home = await tempHome();
  await saveLogin(home, "clearpass", CLEARPASS_LOGIN);
  const run = await brokerRun({ interactive: true, home, env: { FAKE_401: "clearpass" }, tool: "clearpass_list_roles", answers: ["1"] });
  expect(run.toolResultText).toBe("The ClearPass login didn't work (it may have expired), and the person didn't replace it now. Don't ask them in chat; they can type /mcp login clearpass.");
  expect((await readLogins(home)).clearpass).toEqual(CLEARPASS_LOGIN);
  expect(run.restarts).toEqual([]);
  const once = await brokerRun({ interactive: false, home, env: { FAKE_EXPIRED: "clearpass" }, tool: "clearpass_list_roles" });
  expect(once.output).toBe("The ClearPass login didn't work (it may have expired). Run casper and type /mcp login clearpass.\n");
  expect(once.toolResultText).toBe("The ClearPass login didn't work (it may have expired). The person can replace it: run casper and type /mcp login clearpass.");
  expect(once.prompts).toEqual([]);
});

test("a login value the server echoes in a successful result is hidden from the AI", async () => {
  const home = await tempHome();
  await saveLogin(home, "central", { CENTRAL_BASE_URL: "https://us1.api.central.arubanetworks.com", CENTRAL_CLIENT_ID: "cid-EXAMPLE-777", CENTRAL_CLIENT_SECRET: "sec-EXAMPLE-888" });
  const run = await brokerRun({ interactive: true, home, env: { FAKE_ECHO_ENV: "CENTRAL_CLIENT_ID" }, tool: "central_list_api_clients" });
  expect(run.transcript).toContain("<secret hidden>");
  expect(run.transcript).not.toContain("cid-EXAMPLE-777");
});

test("a mistyped region is asked again, so one typo never throws the person's yes away", async () => {
  const run = await brokerRun({ interactive: true, tool: "central_list_sites", answers: ["2", "16", "3"], secrets: ["cid-EXAMPLE-1", "sec-EXAMPLE-2"] });
  expect(run.prompts[2]).toBe("That isn't one of them. Type a number from 1 to 15.\n");
  expect((await readLogins(run.home)).central).toEqual({ CENTRAL_BASE_URL: "https://us4.api.central.arubanetworks.com", CENTRAL_CLIENT_ID: "cid-EXAMPLE-1", CENTRAL_CLIENT_SECRET: "sec-EXAMPLE-2" });
  expect(run.output).not.toContain("Not added.");
});

test("after three wrong numbers nothing is saved, and the next try still asks (it isn't Not now)", async () => {
  const run = await brokerRun({ interactive: true, tool: "central_list_sites", answers: ["2", "16", "0", "us1"] });
  expect(run.output).toContain("Not added. Type /mcp login central any time.");
  expect(await readLogins(run.home)).toEqual({});
  expect(run.notNow.has("central")).toBe(false);
});

test("a server matched only by its tool list never gets the login question; its login_missing is an ordinary result", async () => {
  const run = await brokerRun({ interactive: true, lookalike: true, answers: ["2"], secrets: ["tok_EXAMPLE_0123456789"] });
  expect(run.manager.policy("network").match?.by).toBe("tools");
  expect(run.prompts).toEqual([]);
  expect(run.restarts).toEqual([]);
  expect(run.transcript).toContain("login_missing");
  expect(await readLogins(run.home)).toEqual({});
});
