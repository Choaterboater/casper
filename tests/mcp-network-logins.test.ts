import { afterEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MCPServerDefinition } from "../src/mcp/config";
import { definitionHash } from "../src/mcp/consent";
import { MCPManager } from "../src/mcp/manager";
import { forgetLogin, LOGIN_FIELDS, LOGIN_FILE, loginEnv, readLogins, saveLogin, spawnEnvFor } from "../src/mcp/network/logins";
import { networkServerEntry } from "../src/mcp/network/server";
import { PRIVATE_PATHS } from "../src/platform/project-paths";
import { networkLoginValues } from "../src/secrets/files";
import { scrubToolOutput } from "../src/secrets/tool-output";
import { scrubText } from "../src/secrets/scrub";
import { allowSlowServerStopsOnWindows, fakeProgram, fakeServerProgram } from "./support/fake-program";
import { needsPosixModes, needsSymlinks, posixModes } from "./support/platform";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function tempHome(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "casper-network-logins-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const key = randomBytes(32);

function networkDefinition(home: string, scope: MCPServerDefinition["scope"] = "user"): MCPServerDefinition {
  return { name: "network", source: path.join(home, ".casper/mcp.json"), scope, cwd: home, disabled: false, transport: { type: "stdio", ...networkServerEntry(home) } };
}

allowSlowServerStopsOnWindows();

/** Where Casper's installed program goes; the tests put a fake there (tests/support/fake-program.ts). */
async function installedProgram(home: string): Promise<string> {
  const entry = networkServerEntry(home).command;
  await mkdir(path.dirname(entry), { recursive: true });
  return entry;
}

test("each product's login fields are the server's own login variables", () => {
  expect(LOGIN_FIELDS.mist.map((field) => field.env)).toEqual(["MIST_HOST", "MIST_API_TOKEN"]);
  expect(LOGIN_FIELDS.central.map((field) => field.env)).toEqual(["CENTRAL_BASE_URL", "CENTRAL_CLIENT_ID", "CENTRAL_CLIENT_SECRET"]);
  expect(LOGIN_FIELDS.clearpass.map((field) => field.env)).toEqual(["CLEARPASS_BASE_URL", "CLEARPASS_API_TOKEN"]);
  expect(LOGIN_FIELDS.mist[0]!.choices?.[0]).toEqual({ label: "Global 01 (api.mist.com)", value: "https://api.mist.com" });
  expect(LOGIN_FIELDS.central[0]!.choices?.some((choice) => choice.value === "https://us1.api.central.arubanetworks.com")).toBe(true);
  expect(LOGIN_FIELDS.clearpass[0]!.choices).toBeUndefined();
  for (const fields of Object.values(LOGIN_FIELDS)) expect(fields.filter((field) => field.secret).length).toBe(1);
});

test("login values are injected at spawn but are not part of the definition hash", async () => {
  const home = await tempHome();
  const def = networkDefinition(home);
  const before = definitionHash(def, key, "casper-network-mcp");
  await saveLogin(home, "mist", { MIST_HOST: "https://api.mist.com", MIST_API_TOKEN: "tok_EXAMPLE_0123456789" });
  expect(definitionHash(def, key, "casper-network-mcp")).toBe(before);
  expect(JSON.stringify(def)).not.toContain("tok_EXAMPLE_0123456789");
  expect((await spawnEnvFor(def, home)).MIST_API_TOKEN).toBe("tok_EXAMPLE_0123456789");
  expect(await loginEnv(home)).toEqual({ MIST_HOST: "https://api.mist.com", MIST_API_TOKEN: "tok_EXAMPLE_0123456789" });
});

test("logins go only to your own network server: never to a project's server or another program", async () => {
  const home = await tempHome();
  await saveLogin(home, "mist", { MIST_HOST: "https://api.mist.com", MIST_API_TOKEN: "tok_EXAMPLE_0123456789" });
  expect((await spawnEnvFor(networkDefinition(home, "project"), home)).MIST_API_TOKEN).toBeUndefined();
  const other: MCPServerDefinition = { ...networkDefinition(home), transport: { type: "stdio", command: "/opt/other/server", args: [], env: {} } };
  expect((await spawnEnvFor(other, home)).MIST_API_TOKEN).toBeUndefined();
});

test("the login file is 0600, private to the AI's shell, and its values are hidden", async () => {
  const home = await tempHome();
  await saveLogin(home, "clearpass", { CLEARPASS_BASE_URL: "https://cppm.example.com", CLEARPASS_API_TOKEN: "abc12" });
  if (posixModes) expect((await stat(path.join(home, LOGIN_FILE))).mode & 0o777).toBe(0o600);
  expect(PRIVATE_PATHS).toContain(".casper/network-logins.json");
  const hidden = networkLoginValues(path.join(home, LOGIN_FILE));
  expect(hidden).toContain("abc12"); // short secrets hidden too (>=4 chars)
  expect(hidden).not.toContain("https://cppm.example.com");
  await saveLogin(home, "central", { CENTRAL_BASE_URL: "https://us1.api.central.arubanetworks.com", CENTRAL_CLIENT_ID: "client-77", CENTRAL_CLIENT_SECRET: "sec-EXAMPLE-99" });
  expect(networkLoginValues(path.join(home, LOGIN_FILE))).toEqual(expect.arrayContaining(["abc12", "client-77", "sec-EXAMPLE-99"]));
  expect(Object.keys(await readLogins(home)).sort()).toEqual(["central", "clearpass"]);
});

needsSymlinks("a linked login file is refused", async () => {
  const home = await tempHome();
  const file = path.join(home, LOGIN_FILE);
  await mkdir(path.dirname(file), { recursive: true });
  const elsewhere = path.join(home, "elsewhere.json");
  await writeFile(elsewhere, "{}\n", { mode: 0o600 });
  await symlink(elsewhere, file);
  await expect(saveLogin(home, "mist", { MIST_HOST: "https://api.mist.com", MIST_API_TOKEN: "tok_EXAMPLE_0123456789" })).rejects.toThrow("symbolic link");
  expect(await readFile(elsewhere, "utf8")).toBe("{}\n");
  const said: string[] = [];
  expect(await readLogins(home, (text) => said.push(text))).toEqual({});
});

// Windows has no group or other mode bits to read, so a "group-readable" file can't be made there.
needsPosixModes("a group-readable login file is refused", async () => {
  const home = await tempHome();
  const file = path.join(home, LOGIN_FILE);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ mist: { MIST_HOST: "https://api.mist.com", MIST_API_TOKEN: "tok_EXAMPLE_0123456789" } }), { mode: 0o644 });
  await chmod(file, 0o644);
  const warned: string[] = [];
  expect(await readLogins(home, (text) => warned.push(text))).toEqual({});
  expect(await loginEnv(home, (text) => warned.push(text))).toEqual({});
  expect(warned).toHaveLength(1);
  expect(warned[0]).toContain("other users");
  expect(warned[0]).toContain("/mcp login");
  // Saving again writes a private file in its place; nothing to edit by hand.
  await saveLogin(home, "mist", { MIST_HOST: "https://api.mist.com", MIST_API_TOKEN: "tok_EXAMPLE_0123456789" });
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect((await readLogins(home)).mist?.MIST_API_TOKEN).toBe("tok_EXAMPLE_0123456789");
});

test("odd values are never saved or read: unknown products and fields, line breaks, a plain-http address", async () => {
  const home = await tempHome();
  await expect(saveLogin(home, "mist", { MIST_HOST: "https://api.mist.com", MIST_API_TOKEN: "tok\nEXAMPLE" })).rejects.toThrow();
  await expect(saveLogin(home, "mist", { MIST_HOST: "https://api.mist.com" })).rejects.toThrow();
  await expect(saveLogin(home, "mist", { MIST_HOST: "https://api.mist.com", MIST_API_TOKEN: "tok_EXAMPLE_0123456789", OTHER: "x" })).rejects.toThrow();
  await expect(saveLogin(home, "clearpass", { CLEARPASS_BASE_URL: "http://cppm.example.com", CLEARPASS_API_TOKEN: "abc12" })).rejects.toThrow("https");
  await expect(saveLogin(home, "nope" as never, {})).rejects.toThrow();
  const file = path.join(home, LOGIN_FILE);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ mist: { MIST_HOST: "https://api.mist.com", MIST_API_TOKEN: "tok_EXAMPLE_0123456789", PATH: "/tmp" }, other: { X: "y" } }), { mode: 0o600 });
  expect(await loginEnv(home)).toEqual({ MIST_HOST: "https://api.mist.com", MIST_API_TOKEN: "tok_EXAMPLE_0123456789" });
});

test("forgetting a login drops it from spawn env and from hidden values", async () => {
  const home = await tempHome();
  await saveLogin(home, "mist", { MIST_HOST: "https://api.mist.com", MIST_API_TOKEN: "tok_EXAMPLE_0123456789" });
  await saveLogin(home, "clearpass", { CLEARPASS_BASE_URL: "https://cppm.example.com", CLEARPASS_API_TOKEN: "cp_EXAMPLE_4455" });
  const file = path.join(home, LOGIN_FILE);
  expect(networkLoginValues(file)).toContain("tok_EXAMPLE_0123456789");
  await forgetLogin(home, "mist");
  const env = await spawnEnvFor(networkDefinition(home), home);
  expect(env.MIST_API_TOKEN).toBeUndefined();
  expect(env.MIST_HOST).toBeUndefined();
  expect(env.CLEARPASS_API_TOKEN).toBe("cp_EXAMPLE_4455");
  expect(networkLoginValues(file)).not.toContain("tok_EXAMPLE_0123456789");
  expect(await readFile(file, "utf8")).not.toContain("tok_EXAMPLE_0123456789");
  if (posixModes) expect((await stat(file)).mode & 0o777).toBe(0o600);
  await forgetLogin(home, "clearpass");
  expect(await readLogins(home)).toEqual({});
  expect(networkLoginValues(file)).toEqual([]);
});

test("the manager starts Casper's network server with the saved logins, read-only, and hides them in its output", async () => {
  const home = await tempHome();
  await saveLogin(home, "mist", { MIST_HOST: "https://api.mist.com", MIST_API_TOKEN: "tok_EXAMPLE_0123456789" });
  await fakeServerProgram(await installedProgram(home), "mcp-network-server", { FIXTURE_ENV_DUMP: "1" });
  const manager = new MCPManager({ servers: [networkDefinition(home)], diagnostics: [] }, { timeoutMs: 10_000, homeDir: home });
  cleanup.push(() => manager.close());
  await manager.connect("network");
  const raw = await manager.call("network", "get_env", {}) as { content: { text: string }[] };
  const seen = JSON.parse(raw.content[0]!.text) as { argv: string[]; env: Record<string, string> };
  expect(seen.argv).toEqual(["--read-only"]);
  expect(seen.env.MIST_API_TOKEN).toBe("tok_EXAMPLE_0123456789");
  // Without a home folder for logins (a manager built for one check), nothing is added.
  const bare = new MCPManager({ servers: [networkDefinition(home)], diagnostics: [] }, { timeoutMs: 10_000 });
  cleanup.push(() => bare.close());
  await bare.connect("network");
  const bareRaw = await bare.call("network", "get_env", {}) as { content: { text: string }[] };
  expect(JSON.parse(bareRaw.content[0]!.text).env.MIST_API_TOKEN).toBeUndefined();
});

test("a login the server prints on stderr is hidden in /mcp", async () => {
  const home = await tempHome();
  await saveLogin(home, "mist", { MIST_HOST: "https://api.mist.com", MIST_API_TOKEN: "tok_EXAMPLE_0123456789" });
  await fakeProgram(await installedProgram(home), "err(`login with ${process.env.MIST_API_TOKEN} refused\\n`);\nprocess.exit(1);");
  const manager = new MCPManager({ servers: [networkDefinition(home)], diagnostics: [] }, { timeoutMs: 10_000, homeDir: home });
  cleanup.push(() => manager.close());
  await manager.connect("network").catch(() => {});
  const status = manager.status().find((entry) => entry.name === "network")!;
  expect(status.state).toBe("failed");
  const shown = JSON.stringify(status);
  expect(shown).toContain("refused");
  expect(shown).not.toContain("tok_EXAMPLE_0123456789");
});

test("a saved login that shows up in the AI's shell output is hidden", async () => {
  const home = await tempHome();
  await saveLogin(home, "clearpass", { CLEARPASS_BASE_URL: "https://cppm.example.com", CLEARPASS_API_TOKEN: "cp_EXAMPLE_4455" });
  const scrubber = { scrubText: async (text: string) => ({ ...scrubText(text), netconan: "off" as const }) };
  const out = await scrubToolOutput(scrubber, "bash", { command: "env" }, ["token is cp_EXAMPLE_4455 here"], undefined,
    { configs: false, loginFile: path.join(home, "no-auth.json"), networkLoginFile: path.join(home, LOGIN_FILE), env: {} });
  expect(out?.texts[0]).not.toContain("cp_EXAMPLE_4455");
});
