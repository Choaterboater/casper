import { afterEach, expect } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { posixOnly } from "./support/platform";
import { cleanEnv } from "./support/env";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

interface Payload { messages: Array<{ role: string; content: unknown }> }
function stream(delta: unknown, finishReason: string | null): string {
  return `data: ${JSON.stringify({ id: "scrub", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
}
function answer(text: string): Response {
  return new Response(stream({ role: "assistant", content: text }, "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}
function calls(tools: Array<{ name: string; args: unknown }>): Response {
  const tool_calls = tools.map((tool, index) => ({ index, id: `call_${index}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }));
  return new Response(stream({ role: "assistant", tool_calls }, null) + stream({}, "tool_calls") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}

const CONFIG = "hostname sw1\nsnmp-server community FixtureComm\n";

/** Runs the Pi fixture once; the model makes the given tool calls in one turn, then answers. */
async function run(tools: Array<{ name: string; args: unknown }>, extraEnv: Record<string, string> = {}) {
  let step = 0;
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-pi-scrub-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home"); const project = path.join(root, "project"); const agent = path.join(home, ".pi/agent");
  await mkdir(agent, { recursive: true }); await mkdir(path.join(project, "backups"), { recursive: true }); await mkdir(path.join(project, "src"));
  await writeFile(path.join(project, "backups/sw1.cfg"), CONFIG);
  await writeFile(path.join(project, "src/parser.test.ts"), `const sample = "snmp-server community FixtureComm";\n`);
  await writeFile(path.join(project, "notes.cfg"), "snmp-server community RealComm\n");
  await writeFile(path.join(project, ".env"), "MIST_APITOKEN=abc123\nCENTRAL_CLIENT_SECRET='s3cr3t-central'\nLOG_LEVEL=debug\n");
  const payloads: Payload[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    payloads.push(await request.json());
    return step++ === 0 ? calls(tools) : answer("done");
  } });
  cleanup.push(async () => { server.stop(true); });
  await writeFile(path.join(agent, "models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "local-fixture-not-a-secret", models: [{ id: "fixture" }],
  } } }));
  await writeFile(path.join(agent, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture", retry: { enabled: false } }));
  await mkdir(path.join(home, ".casper"), { recursive: true });
  await writeFile(path.join(home, ".casper/settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture" }));
  const env = cleanEnv({ HOME: home, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0", ...extraEnv });
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/pi-scrub.ts"), project], { cwd: project, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  const result = JSON.parse(stdout.slice(stdout.indexOf("SCRUB_RESULT=") + "SCRUB_RESULT=".length).trim());
  // Only what the tools gave back (the model's own call arguments are left out).
  const toolMessages = (payloads[1]?.messages ?? []).filter((message) => message.role === "tool");
  return { result, payloads, project, sent: JSON.stringify(toolMessages) };
}

posixOnly("a config file read and config-looking command output reach the model with secrets hidden; source code is unchanged", async () => {
  const { sent } = await run([
    { name: "read", args: { path: "backups/sw1.cfg" } },
    { name: "read", args: { path: "src/parser.test.ts" } },
    { name: "bash", args: { command: "echo snmp-server community BashComm", timeout: 10 } },
  ]);
  expect(sent).not.toContain("community FixtureComm\\n");
  expect(sent).toContain("snmp-server community <secret hidden>");
  expect(sent).toContain("1 secret hidden before the AI saw this (SNMP communities).");
  // The test file keeps its sample line.
  expect(sent).toContain(`const sample = \\"snmp-server community FixtureComm\\"`);
  // A strict rule hit is enough for command output to count as config.
  expect(sent).not.toContain("BashComm");
}, 30_000);

posixOnly("with file scrubbing off, a config file read is unchanged", async () => {
  const { sent } = await run([{ name: "read", args: { path: "backups/sw1.cfg" } }], { FIXTURE_FILES_OFF: "1" });
  expect(sent).toContain("snmp-server community FixtureComm");
}, 30_000);

posixOnly("a write or a shell command that carries <secret hidden> back is refused and nothing changes", async () => {
  const { result, project } = await run([
    { name: "write", args: { path: "notes.cfg", content: "snmp-server community <secret hidden>\n" } },
    { name: "bash", args: { command: "sed -i 's/RealComm/<secret hidden>/' notes.cfg", timeout: 10 } },
  ]);
  const ends = result.toolEnds as Array<{ toolName: string; isError: boolean; output?: { text?: string } }>;
  expect(ends.find((event) => event.toolName === "write")).toMatchObject({ isError: true, output: { text: expect.stringContaining("Not written: the new text has <secret hidden> in it.") } });
  expect(ends.find((event) => event.toolName === "bash")).toMatchObject({ isError: true, output: { text: expect.stringContaining("Not run: the command has <secret hidden> in it.") } });
  expect(await readFile(path.join(project, "notes.cfg"), "utf8")).toBe("snmp-server community RealComm\n");
}, 30_000);

posixOnly("a read-only /delegate child reads config files with secrets hidden too", async () => {
  const { sent } = await run([
    { name: "read", args: { path: "backups/sw1.cfg" } },
    { name: "grep", args: { pattern: "community", path: "backups" } },
  ], { FIXTURE_READ_ONLY: "1" });
  expect(sent).toContain("snmp-server community <secret hidden>");
  expect(sent).not.toContain("FixtureComm");
}, 30_000);

posixOnly("when the secret check itself fails, the output is not shown to the model", async () => {
  const { sent } = await run([{ name: "read", args: { path: "backups/sw1.cfg" } }], { FIXTURE_SCRUB_THROW: "1" });
  expect(sent).not.toContain("FixtureComm");
  expect(sent).toContain("Output not shown: Casper could not check it for device secrets.");
}, 30_000);

posixOnly("a .env read, cat and grep reach the model with values hidden, in the main session and with /secrets files off", async () => {
  const tools = [
    { name: "read", args: { path: ".env" } },
    { name: "bash", args: { command: "cat .env; printenv FIXTURE_PRODUCT_TOKEN", timeout: 10 } },
    { name: "grep", args: { pattern: "TOKEN", path: "." } },
  ];
  for (const extra of [{}, { FIXTURE_FILES_OFF: "1" }] as Record<string, string>[]) {
    const { sent } = await run(tools, { FIXTURE_PRODUCT_TOKEN: "prod-token-0123456789", ...extra });
    expect(sent).not.toContain("abc123");
    expect(sent).not.toContain("s3cr3t-central");
    expect(sent).not.toContain("prod-token-0123456789");
    expect(sent).toContain("MIST_APITOKEN=<secret hidden>");
    // Names and ordinary settings stay, so the AI still knows what the file holds.
    expect(sent).toContain("LOG_LEVEL=debug");
  }
}, 60_000);

posixOnly("a read-only child (/delegate, the model review) never sees a .env value", async () => {
  const { sent } = await run([
    { name: "read", args: { path: ".env" } },
    { name: "grep", args: { pattern: "SECRET", path: "." } },
  ], { FIXTURE_READ_ONLY: "1" });
  expect(sent).not.toContain("abc123");
  expect(sent).not.toContain("s3cr3t-central");
  expect(sent).toContain("CENTRAL_CLIENT_SECRET=");
}, 30_000);
