import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NETCONAN_FAILED, Scrubber, findNetconan, mergeNetconan, netconanPass, scrubNote } from "../src/secrets/netconan";
import { LINE_MARKER, SECRET_MARKER, scrubText } from "../src/secrets/scrub";
import { fakeProgram } from "./support/fake-program";
import { POSIX } from "./support/platform";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function folder() {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-netconan-test-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const tmp = path.join(root, "tmp");
  const bin = path.join(root, "bin");
  await mkdir(tmp);
  await mkdir(bin);
  return { root, tmp, bin, log: path.join(root, "calls.jsonl") };
}

/**
 * A stand-in for netconan 0.15.0 -p, with the behaviour seen on real configs:
 * it rewrites the word "ciphertext" and keeps the value, swaps $9$ values for
 * fake ones, uses netconanRemovedN, and replaces some lines with a comment.
 */
async function fakeNetconan(bin: string, log: string, mode: "work" | "sleep" = "work"): Promise<string> {
  return fakeProgram(path.join(bin, "netconan"), `const input = args[args.indexOf("-i") + 1];
const output = args[args.indexOf("-o") + 1];
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, pid: process.pid, inputMode: fs.statSync(input).mode & 0o777,
  folderMode: fs.statSync(path.dirname(input)).mode & 0o777 }) + "\\n");
if (${JSON.stringify(mode)} === "sleep") { setTimeout(() => {}, 30000); return; }
let n = 0;
const scrubbed = fs.readFileSync(input, "utf8").split("\\n").map((line) => {
  if (line.includes("encrypted-password") || line.includes("key-material")) return '! Sensitive line SCRUBBED by netconan"';
  line = line.replace(/\\bciphertext\\b/g, () => "netconanRemoved" + n++);
  line = line.replace(/\\$9\\$[^\\s";]+/g, "$9$FakeFakeFake");
  line = line.replace("Zq8LeakyToken", () => "netconanRemoved" + n++);
  return line;
}).join("\\n");
fs.writeFileSync(output, scrubbed);
`);
}

const JUNOS = [
  "## Last commit: 2026-09-01 10:00:00 UTC by admin",
  "version 23.4R1.9;",
  "set system root-authentication encrypted-password \"$6$abc$Q0x1c2V0aGlzaGFzaA\"",
  "set system radius-server 10.1.1.40 secret \"$9$Hk5FCtu0IcSeK\"",
  "set services custom-app token Zq8LeakyToken",
  "set services ssl-vpn portal key-material 8f7aLeakedMaterial",
  "set interfaces ge-0/0/0 description uplink",
  "",
].join("\n");

test("findNetconan honours CASPER_NETCONAN=off, a path, and PATH", async () => {
  const { bin, log } = await folder();
  const fake = await fakeNetconan(bin, log);
  expect(await findNetconan({ CASPER_NETCONAN: "off", PATH: bin })).toEqual({ state: "off" });
  expect(await findNetconan({ CASPER_NETCONAN: fake })).toEqual({ state: "found", path: fake });
  expect(await findNetconan({ PATH: bin })).toEqual({ state: "found", path: fake });
  expect(await findNetconan({ PATH: path.join(bin, "missing") })).toEqual({ state: "not-found" });
});

test("netconan adds markers for what the built-in missed; its fake values never come back", async () => {
  const { tmp, bin, log } = await folder();
  const scrubber = new Scrubber({ env: { PATH: bin }, tmpRoot: tmp });
  await fakeNetconan(bin, log);
  const result = await scrubber.scrubText(JUNOS);
  expect(result.netconan).toBe("ok");
  expect(result.text).toContain(`set services custom-app token ${SECRET_MARKER}`);
  expect(result.text).toContain(LINE_MARKER);
  expect(result.text).not.toContain("8f7aLeakedMaterial");
  expect(result.text).not.toContain("Zq8LeakyToken");
  expect(result.text).not.toContain("netconanRemoved");
  expect(result.text).not.toContain("FakeFakeFake");
  expect(result.text).not.toContain("SCRUBBED by netconan");
  // Casper already hid the password line, so its readable form is kept.
  expect(result.text).toContain(`set system root-authentication encrypted-password "${SECRET_MARKER}"`);
  expect(result.text).toContain("set interfaces ge-0/0/0 description uplink");
  expect(result.hidden).toBe(scrubText(JUNOS).hidden + 2);
  expect(scrubNote(result)).toContain("secrets hidden before the AI saw this");

  const calls = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  expect(calls).toHaveLength(1);
  const { args, inputMode, folderMode } = calls[0];
  expect(args.slice(0, 2)).toEqual(["-p", "-i"]);
  expect(args[3]).toBe("-o");
  expect(args.slice(5)).toEqual(["-l", "ERROR"]);
  expect(args.join(" ")).not.toContain("Zq8LeakyToken"); // the config never goes through argv
  // Windows makes up mode bits, so 0600 and 0700 can be checked only off Windows.
  if (POSIX) {
    expect(inputMode).toBe(0o600);
    expect(folderMode).toBe(0o700);
  }
  expect(await readdir(tmp)).toEqual([]); // the temp folder is gone
});

test("AOS-CX: netconan's rewritten keyword does not leak and does not add markers", () => {
  const original = "user admin group administrators password ciphertext AQBapSecret\n";
  const builtIn = scrubText(original);
  const merged = mergeNetconan(original, builtIn, "user admin group administrators password netconanRemoved0 AQBapSecret\n");
  expect(merged.text).toBe(`user admin group administrators password ciphertext ${SECRET_MARKER}\n`);
  expect(merged.hidden).toBe(1);
});

test("MCP results go through netconan too, inside JSON text blocks", async () => {
  const { tmp, bin, log } = await folder();
  const fake = await fakeNetconan(bin, log);
  const scrubber = new Scrubber({ env: { CASPER_NETCONAN: fake }, tmpRoot: tmp });
  const raw = { content: [{ type: "text", text: JSON.stringify({ device: "edge1", config: JUNOS }) }] };
  const result = await scrubber.scrubValue(raw);
  const config = JSON.parse(result.value.content[0]!.text).config as string;
  expect(config).toContain(`token ${SECRET_MARKER}`);
  expect(config).not.toContain("Zq8LeakyToken");
  expect(result.netconan).toBe("ok");
});

test("a netconan that hangs is stopped; the built-in result is used and /secrets says so", async () => {
  const { tmp, bin, log } = await folder();
  await fakeNetconan(bin, log, "sleep");
  const scrubber = new Scrubber({ env: { PATH: bin }, tmpRoot: tmp, timeoutMs: 500 });
  const started = performance.now();
  const result = await scrubber.scrubText(JUNOS);
  expect(performance.now() - started).toBeLessThan(5000);
  expect(result.netconan).toBe("failed");
  expect(result.text).toBe(scrubText(JUNOS).text);
  expect(scrubNote(result)).toContain(NETCONAN_FAILED);
  expect(await scrubber.statusText(true)).toContain(NETCONAN_FAILED);
  expect(await readdir(tmp)).toEqual([]);
  const { pid } = JSON.parse((await readFile(log, "utf8")).trim().split("\n")[0]!);
  let alive = true;
  for (let attempt = 0; attempt < 50 && alive; attempt++) {
    try { process.kill(pid, 0); await Bun.sleep(20); } catch { alive = false; }
  }
  expect(alive).toBe(false);
});

test("netconan only runs on text that looks like device config", async () => {
  const { tmp, bin, log } = await folder();
  const fake = await fakeNetconan(bin, log);
  expect(await netconanPass("just a note about VLANs\n", { path: fake, tmpRoot: tmp })).toEqual({ status: "skipped" });
  const scrubber = new Scrubber({ env: { PATH: bin }, tmpRoot: tmp });
  expect((await scrubber.scrubValue({ content: [{ type: "text", text: "no config here" }] })).netconan).toBe("skipped");
  await expect(readFile(log, "utf8")).rejects.toThrow();
});

test("/secrets text without netconan", async () => {
  const off = new Scrubber({ env: { CASPER_NETCONAN: "off" } });
  expect(await off.statusText(true)).toBe("Secrets: hidden in MCP results, .env and credential files (always). Device configs in files and command output: on. Extra check: netconan off (built-in only).");
  const missing = new Scrubber({ env: { PATH: "" } });
  expect(await missing.statusText(false)).toBe("Secrets: hidden in MCP results, .env and credential files (always). Device configs in files and command output: off. Extra check: netconan not found (built-in only).");
  const result = await missing.scrubText("snmp-server community Comm1 RO");
  expect(result.text).toBe(`snmp-server community ${SECRET_MARKER} RO`);
  expect(result.netconan).toBe("not-found");
});
