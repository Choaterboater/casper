import { afterEach, expect } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
async function run(tools: Array<{ name: string; args: unknown }>, extraEnv: Record<string, string> = {},
  setup?: (dirs: { root: string; home: string; project: string }) => Promise<void>) {
  let step = 0;
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-pi-scrub-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home"); const project = path.join(root, "project"); const agent = path.join(home, ".pi/agent");
  await mkdir(agent, { recursive: true }); await mkdir(path.join(project, "backups"), { recursive: true }); await mkdir(path.join(project, "src"));
  await writeFile(path.join(project, "backups/sw1.cfg"), CONFIG);
  await writeFile(path.join(project, "src/parser.test.ts"), `const sample = "snmp-server community FixtureComm";\n`);
  await writeFile(path.join(project, "notes.cfg"), "snmp-server community RealComm\n");
  await writeFile(path.join(project, ".env"), "MIST_APITOKEN=abc123\nCENTRAL_CLIENT_SECRET='s3cr3t-central'\nLOG_LEVEL=debug\n");
  await setup?.({ root, home, project });
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
  return { result, payloads, project, root, home, sent: JSON.stringify(toolMessages) };
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

posixOnly("the AI security review's child can't read .env, keys or a file gitleaks flagged, and its greps leave them out", async () => {
  const { sent, result } = await run([
    { name: "read", args: { path: ".env" } },
    { name: "read", args: { path: "src/settings.py" } },
    { name: "read", args: { path: "src/parser.test.ts" } },
    { name: "grep", args: { pattern: "LIVE", path: "." } },
    // Pi drops a leading @ and follows links: the same files by other names.
    { name: "read", args: { path: "@.env" } },
    { name: "read", args: { path: "notes.txt" } },
    { name: "read", args: { path: "code/settings.py" } },
  ], { FIXTURE_REVIEW: "1" }, async ({ project }) => {
    await writeFile(path.join(project, "src/settings.py"), "API_KEY_VALUE = 'LIVE-sk-9f8e7d6c5b4a'\n");
    await writeFile(path.join(project, "src/app.py"), "MODE = 'LIVE-mode'\n");
    await writeFile(path.join(project, ".env"), "MIST_APITOKEN=LIVE-abc123\nDB_URL=postgres://app:LIVE-dbpass@db/app\n");
    await symlink(".env", path.join(project, "notes.txt"));
    await symlink("src", path.join(project, "code"));
  });
  const ends = result.toolEnds as Array<{ toolName: string; isError: boolean; output?: { text?: string } }>;
  expect(ends.filter((event) => event.toolName === "read" && event.isError).map((event) => event.output?.text)).toEqual([
    expect.stringContaining("Not read: .env may hold secrets"), expect.stringContaining("Not read: src/settings.py may hold secrets"),
    expect.stringContaining("Not read: .env may hold secrets"), expect.stringContaining("Not read: .env may hold secrets"),
    expect.stringContaining("Not read: src/settings.py may hold secrets"),
  ]);
  expect(sent).not.toContain("LIVE-dbpass");
  expect(sent).toContain("const sample");
  expect(sent).toContain("src/app.py:1: MODE = 'LIVE-mode'");
  expect(sent).not.toContain("sk-9f8e7d6c5b4a");
  expect(sent).not.toContain("LIVE-abc123");
  expect(sent).toContain("3 matching lines from files that may hold secrets not shown.");
}, 30_000);

/** A project with a link out, a home with private files, and git hooks. */
async function linkedProject({ root, home, project }: { root: string; home: string; project: string }) {
  await mkdir(path.join(root, "outside"), { recursive: true });
  await writeFile(path.join(root, "outside/secret.txt"), "OUTSIDE_SECRET_TEXT\n");
  await symlink(path.join(root, "outside/secret.txt"), path.join(project, "notes.md"));
  await symlink(path.join(root, "outside"), path.join(project, "docs"));
  await mkdir(path.join(home, ".ssh"), { recursive: true });
  await writeFile(path.join(home, ".ssh/id_test"), "PRIVATE_SSH_KEY_TEXT\n");
  await mkdir(path.join(project, ".git/hooks"), { recursive: true });
  await writeFile(path.join(project, ".git/config"), "[core]\n\tbare = false\n");
}

posixOnly("the AI's file tools don't follow links out of the project or read private files", async () => {
  const { sent, result } = await run([
    { name: "read", args: { path: "notes.md" } },
    { name: "read", args: { path: "~/.ssh/id_test" } },
    { name: "grep", args: { pattern: "SECRET", path: "docs" } },
    { name: "ls", args: { path: "docs" } },
  ], {}, linkedProject);
  expect(sent).not.toContain("OUTSIDE_SECRET_TEXT");
  expect(sent).not.toContain("PRIVATE_SSH_KEY_TEXT");
  expect(sent).not.toContain("secret.txt");
  expect(sent).toContain("Not read: notes.md is a link to a place outside this project. Casper doesn't follow links out.");
  expect(sent).toContain("Not read: ~/.ssh is private (keys and logins). Casper keeps it from the AI.");
  expect((result.toolEnds as Array<{ isError: boolean }>).every((end) => end.isError)).toBe(true);
}, 30_000);

posixOnly("a read-only child gets the same file guard", async () => {
  const { sent } = await run([
    { name: "read", args: { path: "notes.md" } },
    { name: "find", args: { pattern: "*", path: "~/.ssh" } },
  ], { FIXTURE_READ_ONLY: "1" }, linkedProject);
  expect(sent).not.toContain("OUTSIDE_SECRET_TEXT");
  expect(sent).not.toContain("id_test");
  expect(sent).toContain("Casper doesn't follow links out.");
  expect(sent).toContain("~/.ssh is private");
}, 30_000);

posixOnly("the AI can't write git hooks or git config, by file tools or by shell; normal writes still work", async () => {
  const { sent, project } = await run([
    { name: "write", args: { path: ".git/hooks/pre-commit", content: "#!/bin/sh\necho pwned\n" } },
    { name: "edit", args: { path: ".git/config", edits: [{ oldText: "bare = false", newText: "bare = false\n\tfsmonitor = ./x" }] } },
    { name: "write", args: { path: "docs/new.md", content: "through the link" } },
    { name: "bash", args: { command: "printf '#!/bin/sh\\n' > .git/hooks/post-checkout", timeout: 10 } },
    { name: "bash", args: { command: "git config core.hooksPath .githooks", timeout: 10 } },
    { name: "write", args: { path: "src/ok.md", content: "fine" } },
  ], {}, linkedProject);
  expect(sent).toContain("Not done: .git/hooks belongs to git itself. Casper doesn't let the AI change it.");
  expect(sent).toContain("Not done: .git/config belongs to git itself.");
  expect(sent).toContain("Not done: docs/new.md is a link to a place outside this project.");
  expect(sent).toContain("Not run: this command changes .git/hooks");
  expect(sent).toContain("Not run: `git config core.hooksPath` changes how git runs programs.");
  const gone = async (file: string) => access(file).then(() => false, () => true);
  expect(await gone(path.join(project, ".git/hooks/pre-commit"))).toBe(true);
  expect(await gone(path.join(project, ".git/hooks/post-checkout"))).toBe(true);
  expect(await gone(path.join(path.dirname(project), "outside/new.md"))).toBe(true);
  expect(await readFile(path.join(project, ".git/config"), "utf8")).toBe("[core]\n\tbare = false\n");
  expect(await readFile(path.join(project, "src/ok.md"), "utf8")).toBe("fine");
}, 30_000);

posixOnly("an edit or write outside the project waits for the session's question; No writes nothing, inside writes never ask", async () => {
  const outsideDir = async ({ root }: { root: string }) => { await mkdir(path.join(root, "outside")); };
  const tools = [
    { name: "write", args: { path: "../outside/servers.json", content: "{}" } },
    { name: "write", args: { path: "src/in.md", content: "fine" } },
  ];
  const no = await run(tools, { FIXTURE_OUTSIDE: "no" }, outsideDir);
  expect(no.sent).toContain("Not done: the user said no to writing it. Don't retry it or work around it.");
  expect(no.result.outsideAsked).toHaveLength(1);
  expect(no.result.outsideAsked[0]).toEndWith(path.join("outside", "servers.json"));
  expect(no.result.outsideWrote).toEqual([]);
  expect(await access(path.join(no.root, "outside", "servers.json")).then(() => true, () => false)).toBe(false);
  expect(await readFile(path.join(no.project, "src/in.md"), "utf8")).toBe("fine");
  const allowed = await run(tools, { FIXTURE_OUTSIDE: "allow" }, outsideDir);
  expect(await readFile(path.join(allowed.root, "outside", "servers.json"), "utf8")).toBe("{}");
  expect(allowed.result.outsideAsked).toHaveLength(1);
  expect(allowed.result.outsideWrote).toEqual(allowed.result.outsideAsked);
}, 60_000);

posixOnly("service logs and a cat of Casper's login file reach the model with the secrets hidden", async () => {
  const loginKey = "sk-or-v1-fixture0123456789abcdef";
  const { sent } = await run([
    { name: "service", args: { action: "logs" } },
    // Named outright the command is refused (see below); the text check can be got around, so the keys are hidden too.
    { name: "bash", args: { command: "cd ~/.casper/agent && cat auth.json", timeout: 10 } },
  ], {}, async ({ home }) => {
    await mkdir(path.join(home, ".casper/agent"), { recursive: true });
    await writeFile(path.join(home, ".casper/agent/auth.json"), JSON.stringify({ openrouter: { type: "api_key", key: loginKey } }));
  });
  expect(sent).toContain("listening on 3000");
  expect(sent).not.toContain("DbPassw0rd99");
  expect(sent).not.toContain("tok-live-778899");
  expect(sent).toContain("openrouter");
  expect(sent).not.toContain(loginKey);
}, 30_000);

posixOnly("the AI's bash never gets AI provider keys; your product tokens stay", async () => {
  const tools = [{ name: "bash", args: { command: "printenv OPENROUTER_API_KEY >/dev/null && echo OPENROUTER-PRESENT || echo OPENROUTER-ABSENT; printenv MIST_API_TOKEN >/dev/null && echo MIST-PRESENT || echo MIST-ABSENT", timeout: 10 } }];
  const { sent } = await run(tools, { OPENROUTER_API_KEY: "sk-or-fixture-provider-key", MIST_API_TOKEN: "mist-fixture-token" });
  expect(sent).toContain("OPENROUTER-ABSENT");
  expect(sent).toContain("MIST-PRESENT");
  expect(sent).not.toContain("sk-or-fixture-provider-key");
}, 30_000);

posixOnly("with no sandbox, the AI's bash can't read ~/.ssh either: the command is refused before it runs", async () => {
  const { sent, result } = await run([
    { name: "bash", args: { command: "cat ~/.ssh/config; cat $HOME/.ssh/id_test", timeout: 10 } },
  ], {}, async ({ home }) => {
    await mkdir(path.join(home, ".ssh"), { recursive: true });
    await writeFile(path.join(home, ".ssh/config"), "Host build-server\n  HostName 198.51.100.20\n  User root\n");
    await writeFile(path.join(home, ".ssh/id_test"), "PRIVATE_SSH_KEY_TEXT\n");
  });
  expect(sent).not.toContain("PRIVATE_SSH_KEY_TEXT");
  expect(sent).not.toContain("198.51.100.20");
  expect(sent).toContain("Not run: this command reads ~/.ssh, which is private (keys and logins). Casper keeps it from the AI.");
  expect((result.toolEnds as Array<{ isError: boolean }>)[0]!.isError).toBe(true);
}, 30_000);

posixOnly("a token the AI typed into a command is hidden in what Casper shows and keeps, and marked for the receipt", async () => {
  const uuid = "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b";
  const { result } = await run([
    { name: "bash", args: { command: `echo "PVEAPIToken=root@pam!sampleapp=${uuid}" > /dev/null`, timeout: 10 } },
  ]);
  const end = (result.toolEnds as Array<{ input?: { command?: string; secretHidden?: boolean } }>)[0]!;
  expect(end.input?.command).not.toContain(uuid);
  expect(end.input?.command).toContain("<secret hidden>");
  expect(end.input?.secretHidden).toBe(true);
}, 30_000);
