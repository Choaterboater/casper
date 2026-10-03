import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { addLabHosts, parseLabFile } from "../src/network/lab-import";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function home() { const dir = await mkdtemp(path.join(os.tmpdir(), "casper-lab-import-")); dirs.push(dir); return dir; }

test("a lab file is JSON with hosts, or one host per line; each entry is checked like lab.hosts", () => {
  expect(parseLabFile('{"hosts": ["lab-sw1", "10.99.0.0/24", "lab-sw1"]}')).toEqual(["lab-sw1", "10.99.0.0/24"]);
  expect(parseLabFile("# lab devices\nlab-sw1\n\n10.99.0.11\n")).toEqual(["lab-sw1", "10.99.0.11"]);
  expect(() => parseLabFile('{"hosts": "lab-sw1"}')).toThrow("hosts");
  expect(() => parseLabFile("lab sw1 with spaces\n")).toThrow();
  expect(() => parseLabFile("")).toThrow("no hosts");
});

test("adding hosts keeps the rest of config.yaml and its comments, and only adds what is new", async () => {
  const dir = await home();
  await mkdir(path.join(dir, ".casper"), { recursive: true });
  await writeFile(path.join(dir, ".casper/config.yaml"), "# mine\nmodel: x\nlab:\n  hosts:\n    - lab-sw1 # core lab\n");
  const result = await addLabHosts(dir, ["lab-sw1", "10.99.0.11"]);
  expect(result).toMatchObject({ added: ["10.99.0.11"], already: ["lab-sw1"] });
  const text = await readFile(path.join(dir, ".casper/config.yaml"), "utf8");
  expect(text).toContain("# mine");
  expect(text).toContain("# core lab");
  expect(text).toContain("model: x");
  expect(text).toContain("- 10.99.0.11");
});

test("with no config.yaml yet, one is made with just the lab list", async () => {
  const dir = await home();
  const result = await addLabHosts(dir, ["lab-r1"]);
  expect(result.added).toEqual(["lab-r1"]);
  expect(await readFile(path.join(dir, ".casper/config.yaml"), "utf8")).toBe("lab:\n  hosts:\n    - lab-r1\n");
});

test("a config.yaml that doesn't parse is left alone", async () => {
  const dir = await home();
  await mkdir(path.join(dir, ".casper"), { recursive: true });
  await writeFile(path.join(dir, ".casper/config.yaml"), "lab: [unclosed\n");
  await expect(addLabHosts(dir, ["lab-r1"])).rejects.toThrow("does not parse");
  expect(await readFile(path.join(dir, ".casper/config.yaml"), "utf8")).toBe("lab: [unclosed\n");
});

// --- /lab and /lab import in a session ------------------------------------------------------------
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import { SkillRegistry } from "../src/skills/registry";

async function session(homeDir: string, project: string, commands: string[], answers: string[]) {
  const input = new PassThrough();
  let output = "";
  const pending = [...commands];
  const app = new CasperApp({
    runtimeFactory: () => { throw new Error("no model in this test"); }, input, sessionHomeDir: homeDir,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir }),
    output: { write: (text) => {
      output += text;
      if (text === "> ") queueMicrotask(() => input.write(`${pending.shift() ?? "/exit"}\n`));
      if (/Type [\d, ]*\d or \d: $/.test(text)) queueMicrotask(() => input.write(`${answers.shift() ?? "1"}\n`));
    } },
  });
  try { await app.runInteractive(project); } finally { await app.close(); }
  return output;
}

test("/lab import lists the new hosts, asks 1 No · 2 Add them, and only 2 writes your config", async () => {
  const dir = await home();
  const project = path.join(dir, "project");
  await mkdir(path.join(project, ".casper"), { recursive: true });
  await writeFile(path.join(dir, "greencli-lab.txt"), "lab-sw1\n10.99.0.11\n");
  const first = await session(dir, project, [`/lab import ${path.join(dir, "greencli-lab.txt")}`], ["1"]);
  expect(first).toContain("Add 2 devices to your lab list (~/.casper/config.yaml)? lab-sw1, 10.99.0.11\n  1 No\n  2 Add them\n");
  expect(first).toContain("[lab] Nothing added.");
  await expect(readFile(path.join(dir, ".casper/config.yaml"), "utf8")).rejects.toThrow();
  const second = await session(dir, project, [`/lab import ${path.join(dir, "greencli-lab.txt")}`, "/lab"], ["2"]);
  expect(second).toContain("[lab] Added 2 devices to ~/.casper/config.yaml: lab-sw1, 10.99.0.11. Device checks no longer call them \"not marked lab\".");
  expect(second).toContain("Lab devices: lab-sw1, 10.99.0.11 (from ~/.casper/config.yaml)");
  expect(await readFile(path.join(dir, ".casper/config.yaml"), "utf8")).toContain("- 10.99.0.11");
});

test("review: when the profile has its own lab list (it wins), /lab import adds to the profile's file", async () => {
  const dir = await home();
  const project = path.join(dir, "project");
  await mkdir(path.join(project, ".casper"), { recursive: true });
  await mkdir(path.join(dir, ".casper/profiles/default"), { recursive: true });
  await writeFile(path.join(dir, ".casper/profiles/default/config.yaml"), "lab:\n  hosts:\n    - lab-r1\n");
  await writeFile(path.join(dir, "lab.txt"), "lab-r2\n");
  const output = await session(dir, project, [`/lab import ${path.join(dir, "lab.txt")}`, "/lab"], ["2"]);
  expect(output).toContain("Add 1 device to your lab list (~/.casper/profiles/default/config.yaml)? lab-r2");
  expect(output).toContain("Lab devices: lab-r1, lab-r2 (from ~/.casper/profiles/default/config.yaml)");
  expect(await readFile(path.join(dir, ".casper/profiles/default/config.yaml"), "utf8")).toContain("- lab-r2");
  await expect(readFile(path.join(dir, ".casper/config.yaml"), "utf8")).rejects.toThrow();
});
