import { afterEach, expect, test } from "bun:test";
import path from "node:path";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { startAcp, until, type AcpClient } from "./support/acp-client";
import { childTestLimit } from "./support/limits";
import { cleanUpAfterEach, fixture } from "./support/scripting";

// Sign-in over ACP (decision 103), against a real `casper acp` router and a session child, on a home with no
// sign-in and no models. The provider's key check is answered inside the children (fixtures/acp-auth-fetch.ts).
const clients: AcpClient[] = [];
afterEach(async () => { for (const client of clients.splice(0)) await client.close().catch(() => {}); });
cleanUpAfterEach();

const INIT = { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "fake-acp-client", version: "1" } };
const GOOD_KEY = "sk-or-good-0123456789abcdefFAKE";
const BAD_KEY = "sk-or-refused-9876543210zyxwFAKE";
const DOWN_KEY = "sk-or-down-5555555555qqqqqFAKE";
/** Every `_casper/auth/update` the agent sent, in order. */
const authUpdates = (client: AcpClient) => client.lines.map((line) => JSON.parse(line) as Record<string, any>).filter((message) => message.method === "_casper/auth/update").map((message) => message.params);
const preload = path.join(import.meta.dir, "fixtures/acp-auth-fetch.ts");
const refusal = (reply: Promise<unknown>) => reply.then(() => undefined, (error: { code: number; message: string }) => ({ code: error.code, message: error.message }));

/** A home with nothing of Casper's in it, and a `casper acp` whose children answer the key check themselves. */
async function emptyHome() {
  const f = await fixture();
  await rm(path.join(f.home, ".casper"), { recursive: true, force: true });
  const fetchLog = path.join(f.root, "fetch.log");
  // Bun reads BUN_OPTIONS unquoted, so the path goes in as it is, with forward slashes.
  const client = startAcp(f, [], { BUN_OPTIONS: `--preload ${preload.split(path.sep).join("/")}`, ACP_AUTH_FETCH_LOG: fetchLog });
  clients.push(client);
  // No key leaves this machine: the fake must be in place before any test sends one.
  await until(() => existsSync(fetchLog), 20_000, "the fake key check to load");
  return { f, client, fetchLog, login: path.join(f.home, ".casper/agent/auth.json") };
}

/** Every file under `folder`, read as text. */
async function filesUnder(folder: string): Promise<Array<{ file: string; text: string }>> {
  const found: Array<{ file: string; text: string }> = [];
  for (const entry of await readdir(folder, { withFileTypes: true, recursive: true }).catch(() => [])) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    found.push({ file, text: await readFile(file, "utf8").catch(() => "") });
  }
  return found;
}

test("On an empty home an app signs in with a key, the next session is signed in, and the key is in the login file only", async () => {
  const { f, client, login } = await emptyHome();
  const hello = await client.request("initialize", INIT);
  const methods = hello.authMethods as Array<Record<string, any>>;
  expect(methods.map((method) => method.id)).toEqual(["openrouter:api_key", "openrouter:oauth", "anthropic:api_key", "anthropic:oauth", "openai-codex:oauth", "github-copilot:oauth"]);
  expect(methods[0]).toMatchObject({ id: "openrouter:api_key", name: "OpenRouter · paste an API key", _meta: { casper: { provider: "openrouter", kind: "api_key" } } });
  expect(methods.find((method) => method.id === "github-copilot:oauth")!._meta.casper.kind).toBe("device_code");

  // Nothing saved yet, and asking does not create the login file.
  expect(await client.request("_casper/auth/status", {})).toEqual({ signIns: [] });
  expect(await stat(login).then(() => true, () => false)).toBe(false);
  await client.request("session/new", { cwd: f.project, mcpServers: [] });
  await until(() => client.stderr().includes("not signed in"), 20_000, "the first session to say it is not signed in");

  expect(await client.request("authenticate", { methodId: "openrouter:api_key", _meta: { casper: { key: GOOD_KEY } } })).toEqual({ _meta: { casper: { provider: "openrouter" } } });
  expect(await client.request("_casper/auth/status", {})).toEqual({ signIns: [{ provider: "openrouter", type: "api_key" }] });

  // A session started now is signed in: it has no model yet only because the first request picks one. (The model list
  // before a first message is a later change; today the picker is sent once a model is in use.)
  const said = client.stderr().length;
  await client.request("session/new", { cwd: f.project, mcpServers: [] });
  await until(() => client.stderr().slice(said).includes("none yet"), 20_000, "the next session to say it is signed in");
  expect(client.stderr().slice(said)).not.toContain("not signed in");

  // The key: in Casper's login file, which only you can read, and nowhere else. Not in what Casper wrote to the app,
  // not on stderr, not in any other file under the home (the conversation logs are there) or the project.
  expect(await readFile(login, "utf8")).toContain(GOOD_KEY);
  if (process.platform !== "win32") expect((await stat(login)).mode & 0o077).toBe(0);
  expect(await client.close()).toBe(0);
  expect(client.lines.join("\n")).not.toContain(GOOD_KEY);
  expect(client.stderr()).not.toContain(GOOD_KEY);
  const holders = [...await filesUnder(f.home), ...await filesUnder(f.project)].filter(({ text }) => text.includes(GOOD_KEY)).map(({ file }) => file);
  expect(holders).toEqual([login]);
}, childTestLimit(4));

test("A key the provider refuses saves nothing and is not repeated; a sign-out removes a saved one", async () => {
  const { client, login, fetchLog } = await emptyHome();
  await client.request("initialize", INIT);
  // What an app can get wrong, before anything is asked of a provider.
  expect(await refusal(client.request("authenticate", { methodId: "nope" }))).toMatchObject({ code: -32602 });
  expect(await refusal(client.request("authenticate", { methodId: "openrouter:api_key" }))).toMatchObject({ code: -32602 });
  expect(await refusal(client.request("authenticate", { methodId: "openrouter:oauth", _meta: { casper: { key: GOOD_KEY } } }))).toMatchObject({ code: -32602 });
  expect(await refusal(client.request("authenticate", { methodId: "openrouter:api_key", _meta: { casper: { key: "has space" } } }))).toMatchObject({ code: -32602 });
  expect(await readFile(fetchLog, "utf8").catch(() => "")).toBe("");

  const refused = await refusal(client.request("authenticate", { methodId: "openrouter:api_key", _meta: { casper: { key: BAD_KEY } } }));
  expect(refused).toEqual({ code: -32000, message: "OpenRouter refused that key. Nothing was saved." });
  expect(await client.request("_casper/auth/status", {})).toEqual({ signIns: [] });
  expect(await readFile(login, "utf8").catch(() => "")).not.toContain(BAD_KEY);
  // Checked with the provider once: a refused key is not tried again.
  expect((await readFile(fetchLog, "utf8")).trim().split("\n")).toEqual(["https://openrouter.ai/api/v1/auth/key"]);

  // The provider could not be reached: /login offers to save the key unchecked, an app's key is not saved.
  const unchecked = await refusal(client.request("authenticate", { methodId: "openrouter:api_key", _meta: { casper: { key: DOWN_KEY } } }));
  expect(unchecked).toEqual({ code: -32000, message: "Casper couldn't check the key with OpenRouter (network error). Nothing was saved." });
  expect(await client.request("_casper/auth/status", {})).toEqual({ signIns: [] });

  await client.request("authenticate", { methodId: "openrouter:api_key", _meta: { casper: { key: GOOD_KEY } } });
  expect(await client.request("_casper/auth/logout", { provider: "openrouter" })).toEqual({ removed: true });
  expect(await client.request("_casper/auth/status", {})).toEqual({ signIns: [] });
  expect(await readFile(login, "utf8")).not.toContain(GOOD_KEY);
  expect(await client.request("_casper/auth/logout", { provider: "openrouter" })).toEqual({ removed: false });
  expect(await refusal(client.request("_casper/auth/logout", {}))).toMatchObject({ code: -32602 });

  expect(await client.close()).toBe(0);
  for (const key of [GOOD_KEY, BAD_KEY, DOWN_KEY]) {
    expect(client.lines.join("\n")).not.toContain(key);
    expect(client.stderr()).not.toContain(key);
  }
}, childTestLimit(2));

test("A code sign-in tells the app the code, one sign-in runs at a time, a cancel stops it, and a finished one is saved", async () => {
  const { client, login, fetchLog } = await emptyHome();
  await client.request("initialize", INIT);
  const stopped = refusal(client.request("authenticate", { methodId: "github-copilot:oauth" }));
  await until(() => authUpdates(client).length === 1, 20_000, "the code to reach the app");
  expect(authUpdates(client)).toEqual([{ methodId: "github-copilot:oauth", step: "device_code", url: "https://github.com/login/device", code: "ABCD-EFGH" }]);
  expect(await refusal(client.request("authenticate", { methodId: "openrouter:api_key", _meta: { casper: { key: GOOD_KEY } } }))).toMatchObject({ code: -32600, message: expect.stringContaining("already running") });
  expect(await refusal(client.request("_casper/auth/logout", { provider: "openrouter" }))).toMatchObject({ code: -32600 });
  client.notify("_casper/auth/cancel", {});
  expect(await stopped).toEqual({ code: -32000, message: "The sign-in was stopped. Nothing was saved." });
  expect(await client.request("_casper/auth/status", {})).toEqual({ signIns: [] });

  // Again, and this time the person enters the code on GitHub's page.
  const signedIn = client.request("authenticate", { methodId: "github-copilot:oauth" });
  await until(() => authUpdates(client).length === 2, 20_000, "the second code to reach the app");
  await writeFile(`${fetchLog}.approved`, "");
  expect(await signedIn).toEqual({ _meta: { casper: { provider: "github-copilot" } } });
  expect(await client.request("_casper/auth/status", {})).toEqual({ signIns: [{ provider: "github-copilot", type: "oauth" }] });
  expect(await readFile(login, "utf8")).toContain("synthetic-");
  expect(await client.close()).toBe(0);
  for (const secret of ["synthetic-device", "synthetic-github-secret", "synthetic-copilot-secret"]) {
    expect(client.lines.join("\n")).not.toContain(secret);
    expect(client.stderr()).not.toContain(secret);
  }
}, childTestLimit(2));
