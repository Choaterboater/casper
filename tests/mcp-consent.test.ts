import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MCPServerDefinition } from "../src/mcp/config";
import { ConsentStore, canonical, definitionHash, definitionIdentity } from "../src/mcp/consent";
import { matchPreset } from "../src/mcp/presets";

const cleanup: string[] = [];
afterEach(async () => { for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function home() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "casper-consent-"));
  cleanup.push(dir);
  return dir;
}
function definition(overrides: Partial<MCPServerDefinition> = {}, env: Record<string, string> = { TOKEN: "hunter2" }): MCPServerDefinition {
  return {
    name: "aruba-central", source: "/home/u/.claude.json", scope: "user", cwd: "/home/u", disabled: false,
    transport: { type: "stdio", command: "/opt/centralmcp/bin/centralmcp", args: ["serve"], env },
    ...overrides,
  };
}
const posix = process.platform !== "win32";

test("a remembered server is remembered by a new store on the same files", async () => {
  const dir = await home();
  const store = new ConsentStore(dir);
  await store.load();
  expect(store.state(definition())).toBe("none");
  expect(await store.remember(definition())).toEqual({ remembered: true });
  expect(store.has(definition())).toBe(true);

  const again = new ConsentStore(dir);
  await again.load();
  expect(again.diagnostics).toEqual([]);
  expect(again.state(definition())).toBe("remembered");
  expect(again.has(definition())).toBe(true);
  // Moving the definition to another file, changing its limits or disabling it is not a change.
  const moved = { ...definition({ source: "/elsewhere.json", scope: "profile" }), importedFrom: "vscode", limits: { callMs: 9 }, shadows: "x" } as MCPServerDefinition;
  expect(again.state(moved)).toBe("remembered");
});

test("changing one env value, an arg, the URL or a header means Casper asks again", async () => {
  const dir = await home();
  const store = new ConsentStore(dir);
  await store.load();
  await store.remember(definition());
  expect(store.state(definition({}, { TOKEN: "hunter3" }))).toBe("changed");
  expect(store.has(definition({}, { TOKEN: "hunter3" }))).toBe(false);
  expect(store.state(definition({ transport: { type: "stdio", command: "/opt/centralmcp/bin/centralmcp", args: ["serve", "--x"], env: { TOKEN: "hunter2" } } }))).toBe("changed");
  expect(store.state(definition({ cwd: "/tmp" }))).toBe("changed");
  const http = definition({ name: "mist", transport: { type: "http", url: "https://mcp.mist.com/mcp", headers: { Authorization: "Bearer a" } } });
  await store.remember(http);
  expect(store.state(http)).toBe("remembered");
  expect(store.state({ ...http, transport: { type: "http", url: "https://mcp.mist.com/mcp", headers: { Authorization: "Bearer b" } } })).toBe("changed");
  expect(store.state({ ...http, transport: { type: "http", url: "https://mcp.mist.com/other", headers: { Authorization: "Bearer a" } } })).toBe("changed");
});

test("a project server is never remembered, even with a matching record", async () => {
  const dir = await home();
  const store = new ConsentStore(dir);
  await store.load();
  await store.remember(definition());
  const project = definition({ scope: "project", source: "/repo/.mcp.json" });
  expect(store.state(project)).toBe("none");
  expect(store.has(project)).toBe(false);
  expect(await store.remember(project)).toEqual({ remembered: false, reason: "Not remembered: aruba-central comes from the project, so Casper asks each time." });
});

test("the store holds keyed hashes only: no values and no plain sha256 of the definition", async () => {
  const dir = await home();
  const store = new ConsentStore(dir);
  await store.load();
  await store.remember(definition());
  const text = await readFile(store.file, "utf8");
  expect(text).not.toContain("hunter2");
  expect(text).not.toContain("centralmcp");
  const record = JSON.parse(text).servers["aruba-central"];
  expect(record.hash).toMatch(/^[0-9a-f]{64}$/);
  const plain = createHash("sha256").update(definitionIdentity(definition())).digest("hex");
  expect(record.hash).not.toBe(plain);
  expect(text).not.toContain(plain);
  // The same definition under another install's key hashes differently.
  const otherDir = await home();
  const other = new ConsentStore(otherDir);
  await other.load();
  await other.remember(definition());
  expect(JSON.parse(await readFile(other.file, "utf8")).servers["aruba-central"].hash).not.toBe(record.hash);
});

test.if(posix)("the store and its key are 0600", async () => {
  const dir = await home();
  const store = new ConsentStore(dir);
  await store.load();
  await store.remember(definition());
  expect((await stat(store.file)).mode & 0o777).toBe(0o600);
  expect((await stat(store.keyFile)).mode & 0o777).toBe(0o600);
});

test.if(posix)("a key other users can read is not used", async () => {
  const dir = await home();
  const store = new ConsentStore(dir);
  await store.load();
  await store.remember(definition());
  await chmod(store.keyFile, 0o644);
  const again = new ConsentStore(dir);
  await again.load();
  expect(again.has(definition())).toBe(false);
  expect(again.diagnostics).toEqual(["~/.casper/mcp-consent.key can be read by other users, so it was not used. Casper will ask again for each server."]);
  // Remembering again makes a fresh private key.
  expect(await again.remember(definition())).toEqual({ remembered: true });
  expect((await stat(again.keyFile)).mode & 0o777).toBe(0o600);
  expect(again.has(definition())).toBe(true);
});

test("a damaged store counts as empty, says so, and does not crash", async () => {
  const dir = await home();
  await mkdir(path.join(dir, ".casper"), { recursive: true });
  await writeFile(path.join(dir, ".casper", "mcp-consent.json"), "{ not json", { mode: 0o600 });
  const store = new ConsentStore(dir);
  await store.load();
  expect(store.state(definition())).toBe("none");
  expect(store.diagnostics).toEqual(["~/.casper/mcp-consent.json is damaged. Casper will ask again for each server."]);
  expect(await store.remember(definition())).toEqual({ remembered: true });
  expect(store.has(definition())).toBe(true);
});

test("forget removes the record", async () => {
  const dir = await home();
  const store = new ConsentStore(dir);
  await store.load();
  await store.remember(definition());
  await store.remember(definition({ name: "other" }));
  expect(await store.forget("aruba-central")).toBe(true);
  expect(await store.forget("aruba-central")).toBe(false);
  expect(store.state(definition())).toBe("none");
  const again = new ConsentStore(dir);
  await again.load();
  expect(again.state(definition())).toBe("none");
  expect(again.state(definition({ name: "other" }))).toBe("remembered");
});

test("unpinned package runners are never remembered, with a line that says why", async () => {
  const dir = await home();
  const store = new ConsentStore(dir);
  await store.load();
  const runner = (command: string, args: string[]) => definition({ name: "srv", transport: { type: "stdio", command, args, env: {} } });
  expect(await store.remember(runner("npx", ["-y", "@acme/netbox-mcp"]))).toEqual({
    remembered: false, reason: "Not remembered: srv is not pinned to a version. An update could add write tools. Pin it (for example @1.4.2) and connect again.",
  });
  expect(await store.remember(runner("uvx", ["netbox-mcp"]))).toEqual({
    remembered: false, reason: "Not remembered: srv is not pinned to a version. An update could add write tools. Pin it (for example ==1.4.2 or a commit) and connect again.",
  });
  expect(await store.remember(runner("docker", ["run", "-i", "--rm", "acme/netbox-mcp:latest"]))).toMatchObject({ remembered: false });
  expect(await store.remember(runner("docker", ["run", "-i", "--rm", "acme/netbox-mcp"]))).toMatchObject({ remembered: false });
  expect(await store.remember(runner("npx", ["-y", "@acme/netbox-mcp@1.4.2"]))).toEqual({ remembered: true });
  expect(await store.remember(runner("uvx", ["netbox-mcp==1.4.2"]))).toEqual({ remembered: true });
  expect(await store.remember(runner("docker", ["run", "-i", "--rm", "-e", "TOKEN", "acme/netbox-mcp:1.4.2"]))).toEqual({ remembered: true });
  // A record written before (say, by hand) still gives no remembered approval for an unpinned runner.
  const unpinned = runner("npx", ["-y", "@acme/netbox-mcp"]);
  const file = JSON.parse(await readFile(store.file, "utf8"));
  const key = Buffer.from((await readFile(store.keyFile, "utf8")).trim(), "hex");
  file.servers.srv = { hash: definitionHash(unpinned, key, matchPreset(unpinned)?.preset.id), at: "" };
  await writeFile(store.file, JSON.stringify(file));
  await store.load();
  expect(store.state(unpinned)).toBe("remembered");
  expect(store.has(unpinned)).toBe(false);
});

test("the 'found servers' line is shown once per new set of imported names", async () => {
  const dir = await home();
  const store = new ConsentStore(dir);
  await store.load();
  expect(store.importSetIsNew([])).toBe(false);
  expect(store.importSetIsNew(["junos", "aruba-central"])).toBe(true);
  await store.markImportSet(["junos", "aruba-central"]);
  expect(store.importSetIsNew(["aruba-central", "junos"])).toBe(false);
  expect(store.importSetIsNew(["aruba-central", "junos", "netbox"])).toBe(true);
  const again = new ConsentStore(dir);
  await again.load();
  expect(again.importSetIsNew(["junos", "aruba-central"])).toBe(false);
});

test("canonical JSON sorts keys at every level", () => {
  expect(canonical({ b: 1, a: { d: 1, c: [2, { f: 1, e: 2 }] } })).toBe('{"a":{"c":[2,{"e":2,"f":1}],"d":1},"b":1}');
});

// --- Remembered change kinds (/mcp allow <server>, then 2 Remember) -----------------------------

test("remembered change kinds survive a new store, and a changed definition drops them", async () => {
  const dir = await home();
  const store = new ConsentStore(dir);
  await store.load();
  expect(store.rememberedKinds(definition())).toEqual([]);
  expect(await store.rememberKinds(definition(), ["firmware", "admin"])).toEqual({ remembered: true });
  expect(store.rememberedKinds(definition())).toEqual(["firmware", "admin"]);
  const again = new ConsentStore(dir);
  await again.load();
  expect(again.rememberedKinds(definition())).toEqual(["firmware", "admin"]);
  // Another program under the same name: nothing carries over.
  expect(again.rememberedKinds(definition({}, { TOKEN: "other" }))).toEqual([]);
  // The file itself never names a definition value.
  expect(await readFile(again.file, "utf8")).not.toContain("hunter2");
});

test("only risky kinds are remembered; project servers never; off clears them", async () => {
  const dir = await home();
  const store = new ConsentStore(dir);
  await store.load();
  expect(await store.rememberKinds(definition(), ["config", "delete", "nonsense" as never])).toEqual({ remembered: true });
  expect(store.rememberedKinds(definition())).toEqual(["delete"]);
  const project = definition({ scope: "project" });
  expect((await store.rememberKinds(project, ["delete"])).remembered).toBe(false);
  expect(store.rememberedKinds(project)).toEqual([]);
  expect(await store.forgetKinds("aruba-central")).toBe(true);
  expect(store.rememberedKinds(definition())).toEqual([]);
  expect(await store.forgetKinds("aruba-central")).toBe(false);
});

test("a hand-edited kinds entry with an unknown kind or a bad hash is ignored", async () => {
  const dir = await home();
  const store = new ConsentStore(dir);
  await store.load();
  await store.rememberKinds(definition(), ["admin"]);
  const document = JSON.parse(await readFile(store.file, "utf8")) as { kinds: Record<string, { hash: string; kinds: string[] }> };
  document.kinds["aruba-central"]!.kinds.push("everything");
  document.kinds["other"] = { hash: "nothex", kinds: ["delete"] };
  await writeFile(store.file, JSON.stringify(document));
  const again = new ConsentStore(dir);
  await again.load();
  expect(again.rememberedKinds(definition())).toEqual(["admin"]);
  expect(again.rememberedKinds(definition({ name: "other" }))).toEqual([]);
});

test("review: /mcp forget also drops the server's remembered kinds", async () => {
  const dir = await home();
  const store = new ConsentStore(dir);
  await store.load();
  await store.remember(definition());
  await store.rememberKinds(definition(), ["admin"]);
  await store.forget("aruba-central");
  expect(store.rememberedKinds(definition())).toEqual([]);
});
