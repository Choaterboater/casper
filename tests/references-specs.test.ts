import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  catalogListText, cloneCommands, planReferenceAdd, runReferenceAdd, SPEC_REPOS, type ReferenceAddHost,
} from "../src/references/catalog";
import { addReferenceSource, discoverReferenceConfiguration } from "../src/references/config";
import { ReferenceLibrary } from "../src/references/library";
import { SECRET_MARKER } from "../src/secrets/scrub";
import { posixModes } from "./support/platform";

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
  if (posixModes) expect((await stat(path.join(home, ".casper/references.yaml"))).mode & 0o777).toBe(0o600);
});

test("the catalog lists the spec repos in plain words", () => {
  // mist-openapi is gone: the repo no longer has the folder it fetched, so it gave nothing to search.
  expect(SPEC_REPOS.map((entry) => entry.id)).toEqual(["junos-yang", "pycentral", "pyaoscx", "pyclearpass", "mistapi", "junos-pyez"]);
  expect(planReferenceAdd("mist-openapi", undefined, "/h")).toMatchObject({ error: expect.stringContaining("Unknown name: mist-openapi") });
  expect(catalogListText()).toBe([
    "junos-yang   Junos YANG models, one release (needs a release, e.g. 23.4)",
    "pycentral    Aruba Central Python SDK (MIT)",
    "pyaoscx      AOS-CX Python SDK, REST API (Apache-2.0)",
    "pyclearpass  ClearPass Python SDK, REST API (MIT)",
    "mistapi      Mist API Python SDK (community) (MIT)",
    "junos-pyez   Junos PyEZ Python library (Apache-2.0)",
  ].join("\n"));
});

test("every catalog entry is a public https GitHub repo with a licence and a plain use", () => {
  for (const entry of SPEC_REPOS) {
    expect(entry.url).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/);
    expect(entry.license.length).toBeGreaterThan(0);
    expect(entry.useFor.length).toBeGreaterThan(0);
    if (entry.maxFileBytes !== undefined) expect(entry.maxFileBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
  }
});

test("AOS-CX, Central, ClearPass, Mist and Junos SDKs: sparse folders, search paths and file limits match the checked layouts", () => {
  const expected: Record<string, { sparse: string[]; paths: string[]; maxFileBytes?: number; url: string }> = {
    // pycentral/troubleshooting/troubleshooting.py is about 190 KB, over the 128 KiB default.
    pycentral: { url: "https://github.com/aruba/pycentral.git", sparse: ["pycentral", "docs"], paths: ["pycentral", "docs", "README.md"], maxFileBytes: 262_144 },
    pyaoscx: { url: "https://github.com/aruba/pyaoscx.git", sparse: ["pyaoscx", "docs"], paths: ["pyaoscx", "docs", "README.md"] },
    // pyclearpass/api_enforcementprofile.py is about 245 KB.
    pyclearpass: { url: "https://github.com/aruba/pyclearpass.git", sparse: ["pyclearpass"], paths: ["pyclearpass", "README.md"], maxFileBytes: 524_288 },
    // src/mistapi/api/v1/sites/devices.py is about 111 KB, under the 128 KiB default.
    mistapi: { url: "https://github.com/tmunzer/mistapi_python.git", sparse: ["src/mistapi"], paths: ["src/mistapi", "README.md"] },
    "junos-pyez": { url: "https://github.com/Juniper/py-junos-eznc.git", sparse: ["lib/jnpr/junos", "docs"], paths: ["lib/jnpr/junos", "docs", "README.md"] },
  };
  for (const [name, want] of Object.entries(expected)) {
    const request = planReferenceAdd(name, undefined, "/h");
    if (!("plan" in request)) throw new Error(request.error);
    const destination = path.join("/h", ".casper", "reference-repos", name);
    expect(request.plan.commands).toEqual([
      ["git", "-c", "core.hooksPath=/dev/null", "clone", "--depth", "1", "--filter=blob:none", "--sparse", want.url, destination],
      ["git", "-c", "core.hooksPath=/dev/null", "-C", destination, "sparse-checkout", "set", ...want.sparse],
    ]);
    expect(request.plan.source.paths).toEqual(want.paths);
    expect(request.plan.source.maxFileBytes).toBe(want.maxFileBytes);
    expect(planReferenceAdd(name, "23.4", "/h")).toEqual({ error: `Usage: /references add ${name}` });
  }
});

test("junos-yang needs a release; the clone is sparse, shallow and runs no hooks", () => {
  expect(planReferenceAdd("junos-yang", undefined, "/h")).toEqual({ error: "Usage: /references add junos-yang <release>, for example 23.4" });
  expect(planReferenceAdd("junos-yang", "latest", "/h")).toEqual({ error: "Usage: /references add junos-yang <release>, for example 23.4" });
  const request = planReferenceAdd("junos-yang", "23.4", "/h");
  if (!("plan" in request)) throw new Error(request.error);
  expect(request.plan.id).toBe("junos-yang-23.4");
  expect(request.plan.commands[0]).toEqual(["git", "-c", "core.hooksPath=/dev/null", "clone", "--depth", "1", "--filter=blob:none", "--sparse",
    "https://github.com/Juniper/yang.git", path.join("/h/.casper/reference-repos/junos-yang-23.4")]);
  expect(request.plan.commands[1]).toEqual(["git", "-c", "core.hooksPath=/dev/null", "-C", path.join("/h/.casper/reference-repos/junos-yang-23.4"),
    "sparse-checkout", "set", "--no-cone", "/23.4/*/junos/conf/", "/23.4/*/common/"]);
  expect(request.plan.source).toMatchObject({ paths: ["23.4"], maxFileBytes: 4_194_304 });
  const pyez = SPEC_REPOS.find((entry) => entry.id === "junos-pyez")!;
  expect(cloneCommands(pyez, "/d")[0]).toContain("--depth");
});

function host(answer: string | undefined, code = 0, reload?: () => Promise<void>) {
  const lines: string[] = [];
  const calls: string[][] = [];
  const prompts: string[] = [];
  const value: ReferenceAddHost = {
    print: (line) => { lines.push(line); },
    choose: async (preview, question, choices) => { prompts.push(`${preview}${question}`); return answer !== undefined && choices.includes(answer) ? answer : answer === undefined ? undefined : "no"; },
    runGit: async (argv) => { calls.push(argv); return { code }; },
    ...(reload ? { reload } : {}),
  };
  return { value, lines, calls, prompts };
}

test("/references add pycentral: nothing is downloaded or written unless the user picks 2 Download", async () => {
  const { home, config } = await fixture();
  await writeFile(config, "references: {}\n");
  const no = host("1");
  expect(await runReferenceAdd("pycentral", undefined, home, no.value)).toBe(false);
  expect(no.calls).toEqual([]);
  expect(no.prompts).toEqual(["Download pycentral?\n  1 No\n  2 Download\nType 1 or 2: "]);
  const enter = host("no");
  expect(await runReferenceAdd("pycentral", undefined, home, enter.value)).toBe(false);
  expect(enter.calls).toEqual([]);
  // The shown command is the argv that runs, with home as ~, so it keeps the platform's separators.
  expect(no.lines[0]).toBe(`Will run: git -c core.hooksPath=/dev/null clone --depth 1 --filter=blob:none --sparse https://github.com/aruba/pycentral.git ~${path.join("/.casper/reference-repos/pycentral")}`);
  expect(await readFile(config, "utf8")).toBe("references: {}\n");

  let reloaded = 0;
  const yes = host("2", 0, async () => { reloaded++; });
  expect(await runReferenceAdd("pycentral", undefined, home, yes.value)).toBe(true);
  expect(reloaded).toBe(1);
  const request = planReferenceAdd("pycentral", undefined, home);
  if (!("plan" in request)) throw new Error(request.error);
  expect(yes.calls).toEqual(request.plan.commands); // what was shown is what ran, argv only
  expect(yes.lines).toContain("Downloading (up to 5 minutes; Ctrl+C stops it)...");
  expect(no.lines).not.toContain("Downloading (up to 5 minutes; Ctrl+C stops it)...");
  expect(yes.lines.at(-1)).toBe("Added pycentral to ~/.casper/references.yaml. The AI can search it now.");
  const { discovered } = await library(home);
  expect(discovered.sources.map((entry) => entry.id)).toEqual(["pycentral"]);

  const again = host("2");
  expect(await runReferenceAdd("pycentral", undefined, home, again.value)).toBe(false);
  expect(again.lines).toEqual(["pycentral is already in ~/.casper/references.yaml. Nothing changed."]);
  expect(again.calls).toEqual([]);
});

test("/references add: a failed download adds nothing", async () => {
  const { home, config } = await fixture();
  await writeFile(config, "references: {}\n");
  const failed = host("2", 128);
  expect(await runReferenceAdd("pycentral", undefined, home, failed.value)).toBe(false);
  expect(failed.lines.at(-1)).toBe("Download failed (git exit 128). Nothing was added.");
  expect(await readFile(config, "utf8")).toBe("references: {}\n");
});

test("/references add tips point at Casper's own network server; no name lists the catalog", async () => {
  const { home } = await fixture();
  const mist = host("2");
  await runReferenceAdd("mistapi", undefined, home, mist.value);
  expect(mist.lines.at(-1)).toBe("Tip: mistapi is a community SDK. Casper's network server has a tool for every Mist API call (/mcp setup network).");
  expect(mist.lines.join("\n")).not.toContain("hpe-networking-mcp");
  const cx = host("2");
  await runReferenceAdd("pyaoscx", undefined, home, cx.value);
  expect(cx.lines.at(-2)).toBe("Added pyaoscx to ~/.casper/references.yaml. Restart Casper to search it.");
  expect(cx.lines.at(-1)).toBe("Tip: the SDK covers some firmware versions only. Your switch's own REST API reference is the final word for its firmware.");
  const cppm = host("2");
  await runReferenceAdd("pyclearpass", undefined, home, cppm.value);
  expect(cppm.lines.at(-1)).toBe("Tip: your ClearPass server's API Explorer is the final word for its version.");
  const list = host("2");
  await runReferenceAdd(undefined, undefined, home, list.value);
  expect(list.lines).toEqual([catalogListText()]);
});

test("excerpts hide secret-named values, URL passwords, Bearer tokens and Casper's own secret values too", async () => {
  const { home, repo, config } = await fixture();
  const own = "sk-fixture-ABCDEFGHIJ0123456789";
  await writeFile(path.join(repo, "models/setup.md"), [
    "setup MIST_APITOKEN=abc123def456", "setup DATABASE_URL=postgres://app:Hunter2x@db/app",
    "setup Authorization: Bearer eyJhbGciOiJIUzI1NiJ9abcdef", `setup the key is ${own}`, "",
  ].join("\n"));
  await writeFile(path.join(repo, "models/secrets.yaml"), "setup_password: Plain-Value-1\n");
  await writeFile(config, `references:\n  specs:\n    path: ${repo}\n    paths: [models]\n`);
  const discovered = await discoverReferenceConfiguration({ homeDir: home });
  const search = new ReferenceLibrary(discovered, { secretValues: () => [own] });
  cleanup.push(() => search.close());
  const result = await search.search({ query: "setup" });
  const text = JSON.stringify(result.matches);
  for (const value of ["abc123def456", "Hunter2x", "eyJhbGciOiJIUzI1NiJ9abcdef", own, "Plain-Value-1"]) expect(text).not.toContain(value);
  expect(result.matches).toHaveLength(5);
  expect(result.secretsHidden).toBe(5);
  // A match only inside a hidden value is not returned.
  expect((await search.search({ query: "Hunter2x" })).matches).toEqual([]);
});
