import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  REFERENCE_ADD_PROMPT, catalogListText, cloneCommands, planReferenceAdd, runReferenceAdd, SPEC_REPOS, type ReferenceAddHost,
} from "../src/references/catalog";
import { addReferenceSource, discoverReferenceConfiguration } from "../src/references/config";
import { ReferenceLibrary } from "../src/references/library";
import { SECRET_MARKER } from "../src/secrets/scrub";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-reference-specs-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const repo = path.join(root, "specs");
  await mkdir(path.join(home, ".casper"), { recursive: true });
  await mkdir(path.join(repo, "models"), { recursive: true });
  return { root, home, repo, config: path.join(home, ".casper/references.yaml") };
}

async function library(home: string) {
  const discovered = await discoverReferenceConfiguration({ homeDir: home });
  const result = new ReferenceLibrary(discovered);
  cleanup.push(() => result.close());
  return { library: result, discovered };
}

test("YANG and reStructuredText files are searched", async () => {
  const { home, repo, config } = await fixture();
  await writeFile(path.join(repo, "models/junos-conf-system.yang"), "module junos-conf-system {\n  leaf root-authentication-marker;\n}\n");
  await writeFile(path.join(repo, "models/guide.rst"), "Monitoring\n==========\nnew_monitoring client usage\n");
  await writeFile(config, `references:\n  specs:\n    path: ${repo}\n    paths: [models]\n`);
  const { library: search } = await library(home);
  expect((await search.search({ query: "root-authentication-marker" })).matches.map((entry) => entry.file)).toEqual(["models/junos-conf-system.yang"]);
  expect((await search.search({ query: "new_monitoring" })).matches.map((entry) => entry.file)).toEqual(["models/guide.rst"]);
});

test("per-source maxFileBytes lets a large file be searched; without it the file is reported as too big", async () => {
  const { home, repo, config } = await fixture();
  const big = `${"leaf filler { type string; }\n".repeat(22_000)}leaf needle-at-the-end;\n`;
  expect(Buffer.byteLength(big)).toBeGreaterThan(600 * 1024);
  await writeFile(path.join(repo, "models/big.yang"), big);
  await writeFile(config, `references:\n  specs:\n    path: ${repo}\n    paths: [models]\n`);
  let result = await (await library(home)).library.search({ query: "needle-at-the-end" });
  expect(result.matches).toEqual([]);
  expect(result.status).toBe("partial");
  expect(result.issues.join("\n")).toContain("file exceeds 131072 bytes: models/big.yang");

  await writeFile(config, `references:\n  specs:\n    path: ${repo}\n    paths: [models]\n    maxFileBytes: 4194304\n`);
  const { library: wide, discovered } = await library(home);
  expect(discovered.sources[0]!.maxFileBytes).toBe(4_194_304);
  result = await wide.search({ query: "needle-at-the-end" });
  expect(result.matches.map((entry) => entry.line)).toEqual([22_001]);
});

test("maxFileBytes outside 1 KiB to 4 MiB is rejected", async () => {
  const { home, repo, config } = await fixture();
  for (const value of [10, 5 * 1024 * 1024, "big", 2048.5]) {
    await writeFile(config, JSON.stringify({ references: { specs: { path: repo, paths: ["models"], maxFileBytes: value } } }));
    const { discovered } = await library(home);
    expect(discovered.sources).toEqual([]);
    expect(discovered.diagnostics.join("\n")).toContain("maxFileBytes");
  }
});

test("reference excerpts are scrubbed and a hidden secret is never a match", async () => {
  const { home, repo, config } = await fixture();
  await writeFile(path.join(repo, "models/ap1.txt"), "wlan ssid-profile corp\n   wpa-passphrase SuperPSK123\n");
  await writeFile(config, `references:\n  specs:\n    path: ${repo}\n    paths: [models]\n`);
  const { library: search } = await library(home);
  const result = await search.search({ query: "wpa-passphrase" });
  expect(result.matches[0]!.excerpt).toBe(`   wpa-passphrase ${SECRET_MARKER}`);
  expect(JSON.stringify(result)).not.toContain("SuperPSK123");
  expect(result.secretsHidden).toBe(1);
  expect((await search.search({ query: "SuperPSK123" })).matches).toEqual([]);
});

test("addReferenceSource keeps comments and entries, refuses a duplicate, and the new source is discovered", async () => {
  const { home, repo, config } = await fixture();
  const original = `# my references\nreferences:\n  # the router notes\n  router:\n    path: ${repo}\n    paths: [models]\n`;
  await writeFile(config, original);
  await addReferenceSource(home, "pycentral", { path: "~/.casper/reference-repos/pycentral", paths: ["pycentral", "docs", "README.md"], useFor: ["SDK"] });
  const written = await readFile(config, "utf8");
  expect(written).toContain("# my references");
  expect(written).toContain("# the router notes");
  const { discovered } = await library(home);
  expect(discovered.sources.map((entry) => entry.id)).toEqual(["pycentral", "router"]);
  expect(discovered.sources[0]!.root).toBe(path.join(home, ".casper/reference-repos/pycentral"));
  await expect(addReferenceSource(home, "router", { path: repo, paths: ["x"] })).rejects.toThrow("router is already in ~/.casper/references.yaml. Nothing changed.");
  expect(await readFile(config, "utf8")).toBe(written);
  await expect(addReferenceSource(home, "bad", { path: repo, paths: ["../up"] })).rejects.toThrow("Cannot add bad");
});

test("addReferenceSource creates ~/.casper/references.yaml when it is missing and never touches profiles", async () => {
  const { root } = await fixture();
  const home = path.join(root, "fresh-home");
  const profile = path.join(home, ".casper/profiles/work/references.yaml");
  await addReferenceSource(home, "junos-yang-23.4", { path: "~/.casper/reference-repos/junos-yang-23.4", paths: ["23.4"], maxFileBytes: 4_194_304 });
  const discovered = await discoverReferenceConfiguration({ homeDir: home, profileName: "work" });
  expect(discovered.sources).toMatchObject([{ id: "junos-yang-23.4", paths: ["23.4"], maxFileBytes: 4_194_304 }]);
  await expect(stat(profile)).rejects.toThrow();
  expect((await stat(path.join(home, ".casper/references.yaml"))).mode & 0o777).toBe(0o600);
});

test("the catalog lists three spec repos in plain words", () => {
  expect(SPEC_REPOS.map((entry) => entry.id)).toEqual(["mist-openapi", "junos-yang", "pycentral"]);
  expect(catalogListText()).toBe([
    "mist-openapi  Mist API spec (MIT)",
    "junos-yang    Junos YANG models, one release (needs a release, e.g. 23.4)",
    "pycentral     Aruba Central Python SDK (Apache-2.0)",
  ].join("\n"));
});

test("junos-yang needs a release; the clone is sparse, shallow and runs no hooks", () => {
  expect(planReferenceAdd("junos-yang", undefined, "/h")).toEqual({ error: "Usage: /references add junos-yang <release>, for example 23.4" });
  expect(planReferenceAdd("junos-yang", "latest", "/h")).toEqual({ error: "Usage: /references add junos-yang <release>, for example 23.4" });
  const request = planReferenceAdd("junos-yang", "23.4", "/h");
  if (!("plan" in request)) throw new Error(request.error);
  expect(request.plan.id).toBe("junos-yang-23.4");
  expect(request.plan.commands[0]).toEqual(["git", "-c", "core.hooksPath=/dev/null", "clone", "--depth", "1", "--filter=blob:none", "--sparse",
    "https://github.com/Juniper/yang.git", "/h/.casper/reference-repos/junos-yang-23.4"]);
  expect(request.plan.commands[1]).toEqual(["git", "-c", "core.hooksPath=/dev/null", "-C", "/h/.casper/reference-repos/junos-yang-23.4",
    "sparse-checkout", "set", "--no-cone", "/23.4/*/junos/conf/", "/23.4/*/common/"]);
  expect(request.plan.source).toMatchObject({ paths: ["23.4"], maxFileBytes: 4_194_304 });
  const mist = SPEC_REPOS.find((entry) => entry.id === "mist-openapi")!;
  expect(cloneCommands(mist, "/d")[1]).not.toContain("mist.openapi.json");
});

function host(answer: boolean, code = 0) {
  const lines: string[] = [];
  const calls: string[][] = [];
  const prompts: string[] = [];
  const value: ReferenceAddHost = {
    print: (line) => { lines.push(line); },
    confirmExact: async (prompt) => { prompts.push(prompt); return answer; },
    runGit: async (argv) => { calls.push(argv); return { code }; },
  };
  return { value, lines, calls, prompts };
}

test("/references add pycentral: nothing is downloaded or written unless the user types yes", async () => {
  const { home, config } = await fixture();
  await writeFile(config, "references: {}\n");
  const no = host(false);
  expect(await runReferenceAdd("pycentral", undefined, home, no.value)).toBe(false);
  expect(no.calls).toEqual([]);
  expect(no.prompts).toEqual([REFERENCE_ADD_PROMPT]);
  expect(no.lines[0]).toBe("Will run: git -c core.hooksPath=/dev/null clone --depth 1 --filter=blob:none --sparse https://github.com/aruba/pycentral.git ~/.casper/reference-repos/pycentral");
  expect(await readFile(config, "utf8")).toBe("references: {}\n");

  const yes = host(true);
  expect(await runReferenceAdd("pycentral", undefined, home, yes.value)).toBe(true);
  const request = planReferenceAdd("pycentral", undefined, home);
  if (!("plan" in request)) throw new Error(request.error);
  expect(yes.calls).toEqual(request.plan.commands); // what was shown is what ran, argv only
  expect(yes.lines.at(-1)).toBe("Added pycentral to ~/.casper/references.yaml. Restart Casper to search it.");
  const { discovered } = await library(home);
  expect(discovered.sources.map((entry) => entry.id)).toEqual(["pycentral"]);

  const again = host(true);
  expect(await runReferenceAdd("pycentral", undefined, home, again.value)).toBe(false);
  expect(again.lines).toEqual(["pycentral is already in ~/.casper/references.yaml. Nothing changed."]);
  expect(again.calls).toEqual([]);
});

test("/references add: a failed download adds nothing", async () => {
  const { home, config } = await fixture();
  await writeFile(config, "references: {}\n");
  const failed = host(true, 128);
  expect(await runReferenceAdd("pycentral", undefined, home, failed.value)).toBe(false);
  expect(failed.lines.at(-1)).toBe("Download failed (git exit 128). Nothing was added.");
  expect(await readFile(config, "utf8")).toBe("references: {}\n");
});

test("/references add mist-openapi points at lookup_api; no name lists the catalog", async () => {
  const { home } = await fixture();
  const mist = host(true);
  await runReferenceAdd("mist-openapi", undefined, home, mist.value);
  expect(mist.lines.at(-1)).toBe("Tip: for exact Mist endpoints and fields, lookup_api in hpe-networking-mcp is faster and complete.");
  const list = host(true);
  await runReferenceAdd(undefined, undefined, home, list.value);
  expect(list.lines).toEqual([catalogListText()]);
});
