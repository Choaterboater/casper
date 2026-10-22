import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MCPServerDefinition } from "../src/mcp/config";
import { askForNamedLogin, askToForgetNamedLogin, loginLines, parseLoginCommand, type LoginHost } from "../src/mcp/network/ask-login";
import {
  forgetLogin, forgetNamedLogin, isLoginName, LOGIN_FILE, loginEnv, loginSecretValues, readLogins, readNamedLogins, saveLogin, saveNamedLogin, spawnEnvFor,
} from "../src/mcp/network/logins";
import { networkServerEntry } from "../src/mcp/network/server";
import { CENTRAL_TOKEN_HOST, loginHosts } from "../src/mcp/sandbox/profile";
import { networkLoginValues } from "../src/secrets/files";
import { posixModes } from "./support/platform";
import { removeTempDir } from "./support/temp-dir";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function tempHome(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "casper-named-logins-"));
  cleanup.push(() => removeTempDir(dir));
  return dir;
}

function networkDefinition(home: string): MCPServerDefinition {
  return { name: "network", source: path.join(home, ".casper/mcp.json"), scope: "user", cwd: home, disabled: false, transport: { type: "stdio", ...networkServerEntry(home) } };
}

const MAIN = { CENTRAL_BASE_URL: "https://us1.api.central.arubanetworks.com", CENTRAL_CLIENT_ID: "client-77", CENTRAL_CLIENT_SECRET: "sec-EXAMPLE-99" };
const ACME = { CENTRAL_BASE_URL: "https://de1.api.central.arubanetworks.com", CENTRAL_CLIENT_ID: "acme-client-01", CENTRAL_CLIENT_SECRET: "acme-sec-EXAMPLE-42" };

test("a login name is lowercase letters and digits, never default or forget", () => {
  expect(isLoginName("acme")).toBe(true);
  expect(isLoginName("cust2")).toBe(true);
  expect(isLoginName("a".repeat(32))).toBe(true);
  for (const bad of ["", "Acme", "acme-1", "acme_1", "a".repeat(33), "default", "forget", "ac me"]) expect(isLoginName(bad)).toBe(false);
});

test("/mcp login parses a named Central login and its forget", () => {
  expect(parseLoginCommand(undefined, [])).toEqual({ forget: false });
  expect(parseLoginCommand("central", [])).toEqual({ product: "central", forget: false });
  expect(parseLoginCommand("central", ["forget"])).toEqual({ product: "central", forget: true });
  expect(parseLoginCommand("central", ["acme"])).toEqual({ product: "central", loginName: "acme", forget: false });
  expect(parseLoginCommand("central", ["acme", "forget"])).toEqual({ product: "central", loginName: "acme", forget: true });
  expect(parseLoginCommand("mist", ["forget"])).toEqual({ product: "mist", forget: true });
  // Only Central has named logins; other words stay a usage error.
  expect(parseLoginCommand("mist", ["acme"])).toEqual({ error: "usage" });
  expect(parseLoginCommand("central", ["acme", "now"])).toEqual({ error: "usage" });
  expect(parseLoginCommand("central", ["acme", "forget", "x"])).toEqual({ error: "usage" });
  expect(parseLoginCommand("cisco", [])).toEqual({ error: "usage" });
  expect(parseLoginCommand("central", ["Acme"])).toHaveProperty("error");
  expect(parseLoginCommand("central", ["default"])).toHaveProperty("error");
});

test("a named login starts the server as CENTRAL_<NAME>_…, beside the main login, and its secrets are hidden", async () => {
  const home = await tempHome();
  await saveLogin(home, "central", MAIN);
  await saveNamedLogin(home, "acme", ACME);
  expect(await readLogins(home)).toEqual({ central: MAIN });
  expect(await readNamedLogins(home)).toEqual({ acme: ACME });
  const env = await spawnEnvFor(networkDefinition(home), home);
  expect(env).toMatchObject({
    ...MAIN,
    CENTRAL_ACME_BASE_URL: ACME.CENTRAL_BASE_URL, CENTRAL_ACME_CLIENT_ID: ACME.CENTRAL_CLIENT_ID, CENTRAL_ACME_CLIENT_SECRET: ACME.CENTRAL_CLIENT_SECRET,
  });
  // The server's output hides the named login's client ID and secret, not its address.
  const hidden = loginSecretValues(env);
  expect(hidden).toEqual(expect.arrayContaining([ACME.CENTRAL_CLIENT_ID, ACME.CENTRAL_CLIENT_SECRET, MAIN.CENTRAL_CLIENT_SECRET]));
  expect(hidden).not.toContain(ACME.CENTRAL_BASE_URL);
  // The AI's shell hides them too (the login file's values, one level further in).
  const file = path.join(home, LOGIN_FILE);
  expect(networkLoginValues(file)).toEqual(expect.arrayContaining([ACME.CENTRAL_CLIENT_ID, ACME.CENTRAL_CLIENT_SECRET, MAIN.CENTRAL_CLIENT_ID]));
  if (posixModes) expect((await stat(file)).mode & 0o777).toBe(0o600);
});

test("the sandbox lets the server reach each named login's region and Central's token host", async () => {
  const home = await tempHome();
  await saveNamedLogin(home, "acme", ACME);
  // Only a named login saved: its region and the token host, nothing else.
  expect(loginHosts(await loginEnv(home))).toEqual(["de1.api.central.arubanetworks.com", CENTRAL_TOKEN_HOST]);
  await saveLogin(home, "central", MAIN);
  await saveNamedLogin(home, "lab", { ...ACME, CENTRAL_BASE_URL: "https://central.example.net:8443" });
  expect(loginHosts(await loginEnv(home)).sort()).toEqual(
    ["central.example.net", "de1.api.central.arubanetworks.com", CENTRAL_TOKEN_HOST, "us1.api.central.arubanetworks.com"].sort());
  // A variable that only looks like one (not a login Casper saved, wrong shape) adds nothing.
  expect(loginHosts({ CENTRAL_ACME_URL: "https://elsewhere.example", CENTRAL__BASE_URL: "https://elsewhere.example" })).toEqual([]);
});

test("forgetting keeps the others; saving a product keeps named logins", async () => {
  const home = await tempHome();
  await saveNamedLogin(home, "acme", ACME);
  await saveNamedLogin(home, "lab", MAIN);
  await saveLogin(home, "mist", { MIST_HOST: "https://api.mist.com", MIST_API_TOKEN: "tok_EXAMPLE_0123456789" });
  expect(Object.keys(await readNamedLogins(home)).sort()).toEqual(["acme", "lab"]);
  await forgetLogin(home, "mist");
  expect(Object.keys(await readNamedLogins(home)).sort()).toEqual(["acme", "lab"]);
  await forgetNamedLogin(home, "acme");
  expect(await readNamedLogins(home)).toEqual({ lab: MAIN });
  const file = path.join(home, LOGIN_FILE);
  expect(await readFile(file, "utf8")).not.toContain(ACME.CENTRAL_CLIENT_SECRET);
  expect(networkLoginValues(file)).not.toContain(ACME.CENTRAL_CLIENT_SECRET);
  await forgetNamedLogin(home, "lab");
  // Nothing left: the file goes.
  expect(await stat(file).catch(() => undefined)).toBeUndefined();
});

test("odd named entries are never saved or used", async () => {
  const home = await tempHome();
  await expect(saveNamedLogin(home, "Acme", ACME)).rejects.toThrow(/login name/);
  await expect(saveNamedLogin(home, "default", ACME)).rejects.toThrow(/login name/);
  await expect(saveNamedLogin(home, "acme", { ...ACME, CENTRAL_BASE_URL: "http://de1.api.central.arubanetworks.com" })).rejects.toThrow(/https/);
  await expect(saveNamedLogin(home, "acme", { ...ACME, MIST_API_TOKEN: "x" })).rejects.toThrow(/Not a Central login field/);
  // A hand-edited file: a bad name, a half login and a plain-http address are all left out.
  const file = path.join(home, LOGIN_FILE);
  await saveLogin(home, "central", MAIN);
  const saved = JSON.parse(await readFile(file, "utf8"));
  saved.central_logins = {
    BAD: ACME, half: { CENTRAL_BASE_URL: ACME.CENTRAL_BASE_URL, CENTRAL_CLIENT_ID: "x1234" },
    plain: { ...ACME, CENTRAL_BASE_URL: "http://de1.api.central.arubanetworks.com" }, good: ACME,
  };
  await writeFile(file, JSON.stringify(saved), { mode: 0o600 });
  expect(await readNamedLogins(home)).toEqual({ good: ACME });
  expect(Object.keys(await loginEnv(home)).filter((name) => !(name in MAIN)).sort())
    .toEqual(["CENTRAL_GOOD_BASE_URL", "CENTRAL_GOOD_CLIENT_ID", "CENTRAL_GOOD_CLIENT_SECRET"]);
});

function fakeHost(home: string, answers: string[], secrets: string[]): LoginHost & { output: string; prompts: string[]; restarts: string[] } {
  const host = {
    homeDir: home, interactive: true, canAsk: () => true, output: "", prompts: [] as string[], restarts: [] as string[],
    chooseAnswer: async (preview: string) => { host.prompts.push(preview); return answers.shift(); },
    privateInput: async (label: string) => { host.prompts.push(label); return secrets.shift(); },
    write: (text: string) => { host.output += text; },
    restart: async (server: string) => { host.restarts.push(server); },
    access: () => undefined,
  };
  return host;
}

test("/mcp login central acme asks for the region, client ID and secret, saves it and restarts the server", async () => {
  const home = await tempHome();
  // 2 Add a login, region 7 (EU 1, de1), then the hidden client ID and secret.
  const host = fakeHost(home, ["2", "7"], [ACME.CENTRAL_CLIENT_ID, ACME.CENTRAL_CLIENT_SECRET]);
  expect(await askForNamedLogin(host, "network", "acme")).toBe("added");
  expect(host.prompts[0]).toStartWith('Add a Central login named "acme"?');
  expect(host.prompts[0]).toContain('login="<name>"');
  expect(host.prompts[1]).toContain("EU 1 (de1.api.central.arubanetworks.com)");
  expect(host.prompts.slice(2)).toEqual(["Central API client ID", "Central API client secret"]);
  expect(await readNamedLogins(home)).toEqual({ acme: ACME });
  expect(await readLogins(home)).toEqual({});
  expect(host.restarts).toEqual(["network"]);
  expect(host.output).toContain('Central login "acme" saved.');
  expect(host.output).not.toContain(ACME.CENTRAL_CLIENT_SECRET);
  expect(await loginLines(host, "network")).toContain('Central "acme": set up — /mcp login central acme forget removes it');
  // Asking again offers to replace it; 1 Not now keeps it and doesn't restart.
  const again = fakeHost(home, ["1"], []);
  expect(await askForNamedLogin(again, "network", "acme")).toBe("not-now");
  expect(again.prompts[0]).toStartWith('Replace the Central login "acme"?');
  expect(again.restarts).toEqual([]);
  expect(await readNamedLogins(home)).toEqual({ acme: ACME });
});

test("an empty secret saves nothing; a one-shot run says what to type", async () => {
  const home = await tempHome();
  const host = fakeHost(home, ["2", "1"], [ACME.CENTRAL_CLIENT_ID, ""]);
  expect(await askForNamedLogin(host, "network", "acme")).toBe("not-now");
  expect(await readNamedLogins(home)).toEqual({});
  expect(host.restarts).toEqual([]);
  const once = fakeHost(home, [], []);
  Object.assign(once, { interactive: false, canAsk: () => false });
  expect(await askForNamedLogin(once, "network", "acme")).toBe("cant-ask");
  expect(once.output).toBe("Run casper and type /mcp login central acme.\n");
});

test("/mcp login central acme forget asks, forgets only that login and restarts the server", async () => {
  const home = await tempHome();
  await saveLogin(home, "central", MAIN);
  await saveNamedLogin(home, "acme", ACME);
  const keep = fakeHost(home, ["1"], []);
  expect(await askToForgetNamedLogin(keep, "network", "acme")).toBe("kept");
  expect(keep.prompts[0]).toContain('Forget the Central "acme" login');
  const host = fakeHost(home, ["2"], []);
  expect(await askToForgetNamedLogin(host, "network", "acme")).toBe("forgot");
  expect(host.restarts).toEqual(["network"]);
  expect(await readNamedLogins(home)).toEqual({});
  expect(await readLogins(home)).toEqual({ central: MAIN });
  expect(await askToForgetNamedLogin(fakeHost(home, [], []), "network", "acme")).toBe("none");
});
