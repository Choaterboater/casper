import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sidecarDigest, sidecarProblems } from "../scripts/check-tool-pins";
import { CasperApp, type CasperAppOptions } from "../src/app";
import { loadConfiguration } from "../src/config/load";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime } from "../src/runtime/types";
import { ripgrepPath } from "../src/sandbox/linux";
import { SkillRegistry } from "../src/skills/registry";
import { addToPath, ensureRipgrep, fetchWithTimeout, keepEngineFromFetchingRipgrep, resetRipgrep, RIPGREP_GETTING, type RipgrepResult } from "../src/security/ripgrep";
import { pinnedRipgrepPath, RIPGREP, RIPGREP_VERSION } from "../src/security/ripgrep-pin";
import type { PinnedSpec } from "../src/security/tools";
import { removeTempDir } from "./support/temp-dir";

/** Casper's own ripgrep: no real network anywhere here, the download is a stub. */

const roots: string[] = [];
let home = "";
let empty = "";
beforeEach(async () => {
  resetRipgrep();
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-rg-")));
  roots.push(base);
  home = path.join(base, "home"); empty = path.join(base, "empty-path");
  await mkdir(home); await mkdir(empty);
});
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => removeTempDir(root))); resetRipgrep(); });

const GOOD = new TextEncoder().encode("#!/bin/sh\necho ripgrep 15.2.0\n");
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const exe = process.platform === "win32" ? ".exe" : "";

/** A pinned spec whose download is the stub bytes above, for every computer (raw: no unpacking program needed). */
function stubSpec(sha256 = digest(GOOD)): PinnedSpec {
  const asset = { url: "https://example.invalid/rg", sha256, archive: "raw", member: `rg${exe}` } as const;
  return { ...RIPGREP, source: { kind: "binary", assets: { "linux-x64": asset, "linux-arm64": asset, "darwin-x64": asset, "darwin-arm64": asset, "win32-x64": asset, "win32-arm64": asset } } };
}

function run(extra: Record<string, unknown> = {}, bytes: Uint8Array | Error = GOOD) {
  const lines: string[] = [];
  const urls: string[] = [];
  const options = {
    homeDir: home, env: { PATH: empty } as NodeJS.ProcessEnv, spec: stubSpec(),
    fetchBytes: async (url: string) => { urls.push(url); if (bytes instanceof Error) throw bytes; return bytes; },
    write: (text: string) => { lines.push(text); }, ...extra,
  };
  return { lines, urls, result: ensureRipgrep(options) };
}

test("no ripgrep anywhere: it is fetched with one plain line, checked, and put in ~/.casper/tools/ripgrep-<version>", async () => {
  const { lines, urls, result } = run();
  const found = await result as Extract<RipgrepResult, { path: string }>;
  expect(found.source).toBe("installed");
  expect(found.path).toBe(path.join(home, ".casper", "tools", `ripgrep-${RIPGREP_VERSION}`, "bin", `rg${exe}`));
  expect(found.path).toBe(pinnedRipgrepPath(home));
  expect(lines).toEqual([`${RIPGREP_GETTING}\n`]);
  expect(urls).toHaveLength(1);
  expect(new Uint8Array(await Bun.file(found.path).arrayBuffer())).toEqual(GOOD);
  if (process.platform !== "win32") expect((await stat(found.path)).mode & 0o111).not.toBe(0);
  // The next start finds it without fetching again.
  resetRipgrep();
  const again = run();
  expect((await again.result).source).toBe("pinned");
  expect(again.urls).toEqual([]);
  expect(again.lines).toEqual([]);
});

test("a download that does not match its pinned sha256 is refused: nothing is installed, and it says so", async () => {
  const { lines, result } = run({}, new TextEncoder().encode("not ripgrep"));
  const found = await result;
  expect(found.source).toBe("none");
  expect(lines[0]).toBe(`${RIPGREP_GETTING}\n`);
  expect(lines[1]).toContain("Could not get ripgrep (ripgrep download didn't match the pinned checksum. Nothing was installed.)");
  expect(await readdir(path.join(home, ".casper", "tools")).catch(() => [])).toEqual([]);
});

test("offline, or a download that fails, falls back with one plain line and no crash", async () => {
  const { lines, result } = run({}, new Error("fetch failed"));
  const found = await result;
  expect(found).toMatchObject({ source: "none", why: "failed" });
  expect(lines).toHaveLength(2);
  expect(lines[1]).toBe("Could not get ripgrep (fetch failed). Continuing without it; searching files and the shell sandbox may be limited.\n");
  expect(await readdir(path.join(home, ".casper", "tools")).catch(() => [])).toEqual([]);
});

test("CASPER_OFFLINE or PI_OFFLINE: no download is tried and the start is silent", async () => {
  for (const name of ["CASPER_OFFLINE", "PI_OFFLINE"]) {
    resetRipgrep();
    const { lines, urls, result } = run({ env: { PATH: empty, [name]: "1" } });
    expect(await result).toMatchObject({ source: "none", why: "offline" });
    expect(urls).toEqual([]);
    expect(lines).toEqual([]);
  }
});

test("a ripgrep on PATH wins: nothing is fetched or said", async () => {
  const bin = path.join(home, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, `rg${exe}`), "x");
  const { lines, urls, result } = run({ env: { PATH: bin, PATHEXT: ".EXE" } });
  expect(await result).toEqual({ source: "path", path: path.join(bin, `rg${exe}`) });
  expect(urls).toEqual([]);
  expect(lines).toEqual([]);
});

test("a ripgrep Pi already downloaded into the agent folder counts as one you have", async () => {
  const agent = path.join(home, "agent");
  await mkdir(path.join(agent, "bin"), { recursive: true });
  await writeFile(path.join(agent, "bin", `rg${exe}`), "x");
  const { urls, result } = run({ agentDir: agent });
  expect(await result).toMatchObject({ source: "agent" });
  expect(urls).toEqual([]);
});

test("tools.downloads off: no fetch, no line, and the pinned copy already there is still used", async () => {
  const off = run({ downloads: false });
  expect(await off.result).toEqual({ source: "none", why: "off" });
  expect(off.urls).toEqual([]);
  expect(off.lines).toEqual([]);
  resetRipgrep();
  expect((await run().result).source).toBe("installed");
  resetRipgrep();
  expect((await run({ downloads: false }).result).source).toBe("pinned");
});

test("the real pins: one sha256 per computer, from BurntSushi/ripgrep's own release, checked against its .sha256 files", async () => {
  if (RIPGREP.source.kind !== "binary") throw new Error("ripgrep is a binary pin");
  expect(Object.keys(RIPGREP.source.assets).sort()).toEqual(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"]);
  for (const asset of Object.values(RIPGREP.source.assets)) {
    expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(asset.url).toStartWith(`https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/ripgrep-${RIPGREP_VERSION}-`);
    expect(asset.member).toStartWith(`ripgrep-${RIPGREP_VERSION}-`);
  }
  const sidecars = async (url: string) => {
    const asset = Object.values((RIPGREP.source as { assets: Record<string, { url: string; sha256: string }> }).assets).find((one) => `${one.url}.sha256` === url)!;
    // Linux and macOS publish "<sha256>  <file>"; Windows zips publish CertUtil's output.
    return url.endsWith(".zip.sha256") ? `SHA256 hash of x.zip:\r\n${asset.sha256}\r\nCertUtil: -hashfile command completed successfully.\r\n` : `${asset.sha256}  x\n`;
  };
  expect(await sidecarProblems(RIPGREP, sidecars)).toEqual([]);
  const wrong = await sidecarProblems(RIPGREP, async () => `${"0".repeat(64)}  x\n`);
  expect(wrong).toHaveLength(6);
  expect(wrong[0]).toContain("the release says " + "0".repeat(64));
  expect(sidecarDigest("no digest here")).toBeUndefined();
});

test("the sandbox finds the pinned copy too, after PATH and Pi's own", async () => {
  expect(ripgrepPath(empty, undefined, home)).toBeUndefined();
  await run().result;
  expect(ripgrepPath(empty, undefined, home)).toBe(pinnedRipgrepPath(home));
});

test("addToPath puts the folder at the END of PATH, once, so a ripgrep on PATH always wins", () => {
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
  addToPath(env, "/tools/rg/bin", "linux");
  addToPath(env, "/tools/rg/bin", "linux");
  expect(env.PATH).toBe("/usr/bin:/bin:/tools/rg/bin");
  const windows: NodeJS.ProcessEnv = { Path: "C:\\Windows" };
  addToPath(windows, "C:\\rg", "win32");
  expect(windows.Path).toBe("C:\\Windows;C:\\rg");
});

test("tools.downloads: off loads from your own config; a project file can't set it", async () => {
  const project = path.join(home, "project");
  await mkdir(path.join(project, ".casper"), { recursive: true });
  const load = () => loadConfiguration({ projectRoot: project, homeDir: home });
  expect((await load()).toolDownloads).toBeUndefined();
  await mkdir(path.join(home, ".casper"), { recursive: true });
  await writeFile(path.join(home, ".casper", "config.yaml"), "tools:\n  downloads: off\n");
  expect((await load()).toolDownloads).toBe(false);
  await writeFile(path.join(home, ".casper", "config.yaml"), "tools:\n  downloads: on\n");
  expect((await load()).toolDownloads).toBe(true);
  await writeFile(path.join(home, ".casper", "config.yaml"), "tools:\n  downloads: maybe\n");
  await expect(load()).rejects.toThrow("tools.downloads must be on or off");
  await writeFile(path.join(home, ".casper", "config.yaml"), "tools: off\n");
  await expect(load()).rejects.toThrow("tools must be a mapping");
  await writeFile(path.join(home, ".casper", "config.yaml"), "");
  await writeFile(path.join(project, ".casper", "project.yaml"), "tools:\n  downloads: on\n");
  await expect(load()).rejects.toThrow("tools is a user setting");
});

async function app(options: Partial<CasperAppOptions>, config?: string) {
  const project = path.join(home, "project");
  await mkdir(project, { recursive: true });
  if (config) { await mkdir(path.join(home, ".casper"), { recursive: true }); await writeFile(path.join(home, ".casper", "config.yaml"), config); }
  const runtime: AgentRuntime = {
    async start() { return { getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }), getState: () => ({ cwd: project, isStreaming: false }), subscribe: () => () => {}, abort: async () => {}, setTools: () => {}, prompt: async () => {} }; },
    async dispose() {},
  };
  let output = "";
  const instance = new CasperApp({
    output: { write: (text: string) => { output += text; } }, runtimeFactory: () => runtime, sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
    verificationMode: "off", noSandbox: true, ...options,
  });
  return { instance, project, text: () => output };
}

test("a session asks for ripgrep once at open, passes tools.downloads, and puts a fetched copy on PATH for the grep tool", async () => {
  const saved = process.env.PATH;
  const seen: { downloads?: boolean; homeDir?: string }[] = [];
  try {
    const bin = path.join(home, "fetched");
    const a = await app({ ripgrep: async (options) => { seen.push({ downloads: options.downloads, homeDir: options.homeDir }); options.write?.("Getting ripgrep (one time, about 5 MB)\n"); return { source: "installed", path: path.join(bin, "rg") }; } }, "tools:\n  downloads: off\n");
    await a.instance.runOnce("/status", a.project);
    expect(seen).toEqual([{ downloads: false, homeDir: home }]);
    expect(a.text()).toContain("Getting ripgrep (one time, about 5 MB)\n");
    expect(process.env.PATH!.split(path.delimiter).at(-1)).toBe(bin);
    await a.instance.close();
  } finally { process.env.PATH = saved; }
});

test("a ripgrep that is already on PATH, or a seam that throws, changes nothing and never stops the session", async () => {
  const saved = process.env.PATH;
  try {
    const found = await app({ ripgrep: async () => ({ source: "path", path: "/usr/bin/rg" }) });
    await found.instance.runOnce("/status", found.project);
    expect(process.env.PATH).toBe(saved);
    await found.instance.close();
    const thrown = await app({ ripgrep: async () => { throw new Error("boom"); } });
    await thrown.instance.runOnce("/status", thrown.project);
    expect(thrown.text()).toContain("shell");
    await thrown.instance.close();
  } finally { process.env.PATH = saved; }
});

test("a download larger than the cap is refused before it is hashed", async () => {
  const { readCapped, MAX_DOWNLOAD_BYTES } = await import("../src/security/install");
  const small = new Response("ok");
  expect(new TextDecoder().decode(await readCapped(small))).toBe("ok");
  const declared = new Response("x", { headers: { "content-length": String(MAX_DOWNLOAD_BYTES + 1) } });
  await expect(readCapped(declared)).rejects.toThrow("larger than expected");
});

test("without a usable ripgrep the engine is kept from downloading one (PI_OFFLINE=1); with one it is not forced offline", async () => {
  const saved = { path: process.env.PATH, offline: process.env.PI_OFFLINE };
  // The engine's own check, as tools-manager.js does it when its grep tool finds no rg: read at the moment it looks.
  const wouldDownload = () => !["1", "true", "yes"].includes((process.env.PI_OFFLINE ?? "").toLowerCase());
  try {
    for (const result of [{ source: "none", why: "off" }, { source: "none", why: "failed", message: "x" }, { source: "none", why: "offline" }] as const) {
      delete process.env.PI_OFFLINE;
      const a = await app({ ripgrep: async () => result }, "tools:\n  downloads: off\n");
      await a.instance.runOnce("/status", a.project);
      expect(process.env.PI_OFFLINE as string | undefined).toBe("1");
      expect(wouldDownload()).toBe(false);
      await a.instance.close();
    }
    delete process.env.PI_OFFLINE;
    const thrown = await app({ ripgrep: async () => { throw new Error("boom"); } });
    await thrown.instance.runOnce("/status", thrown.project);
    expect(wouldDownload()).toBe(false);
    await thrown.instance.close();
    for (const result of [{ source: "pinned", path: path.join(home, "bin", "rg") }, { source: "embedded", path: path.join(home, "bin", "rg") }, { source: "path", path: "/usr/bin/rg" }] as const) {
      delete process.env.PI_OFFLINE;
      const good = await app({ ripgrep: async () => result });
      await good.instance.runOnce("/status", good.project);
      expect(process.env.PI_OFFLINE as string | undefined).toBeUndefined();
      await good.instance.close();
    }
  } finally {
    process.env.PATH = saved.path;
    if (saved.offline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = saved.offline;
  }
});

test("keeping the engine offline says so once, and not when it was already offline", () => {
  const env: NodeJS.ProcessEnv = {};
  expect(keepEngineFromFetchingRipgrep(env, { source: "none", why: "failed" })).toContain("/model");
  expect(env.PI_OFFLINE).toBe("1");
  expect(keepEngineFromFetchingRipgrep(env, { source: "none", why: "failed" })).toBeUndefined();
  expect(keepEngineFromFetchingRipgrep({}, { source: "path", path: "/usr/bin/rg" })).toBeUndefined();
});

test("the ripgrep download times out on silence, but a slow body that is still arriving finishes", async () => {
  const slowBody = (async () => new Response(new ReadableStream({ async start(controller) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    controller.enqueue(new Uint8Array([1, 2, 3])); controller.close();
  } }))) as unknown as typeof fetch;
  // Headers answer at once; the body takes longer than the headers limit and is still accepted.
  expect([...await fetchWithTimeout("https://example.invalid/rg", slowBody, { headers: 50, body: 5000 })]).toEqual([1, 2, 3]);
  const silent = ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
  })) as unknown as typeof fetch;
  await expect(fetchWithTimeout("https://example.invalid/rg", silent, { headers: 30, body: 5000 })).rejects.toThrow("did not answer");
});
