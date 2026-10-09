import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discoverMCPConfiguration } from "../src/mcp/config";
import {
  checkLock, fetchReleaseLock, installableReleases, networkReleasesOff, newerNetworkRelease, NETWORK_RELEASE_HOSTS, refreshNetworkReleases,
  RELEASE_CHECK_EVERY_MS, validReleaseVersion, type NetworkReleaseOptions,
} from "../src/mcp/network/releases";
import { NETWORK_SERVER, networkServerEntry } from "../src/mcp/network/server";
import { isCaspersEntry, networkSetupLine, runNetworkSetup, runNetworkUpdate, shouldOfferNetworkUpdate, type SetupHost } from "../src/mcp/network/setup";
import { installedVersion, installLockedSpec } from "../src/security/install";
import type { ToolRunner } from "../src/security/spawn";
import type { LockedSpec } from "../src/security/tools";
import { fakeProgram } from "./support/fake-program";
import { removeTempDir } from "./support/temp-dir";

/** Network server releases between Casper releases: a fake GitHub (releases API and release downloads) on port 0. */

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanup.push(() => removeTempDir(dir));
  return dir;
}

const BUNDLED = NETWORK_SERVER.version;
/** A version above the bundled pin, whatever the pin is. */
const bump = (version: string, by = 1) => { const parts = version.split(".").map(Number); parts[2]! += by; return parts.join("."); };
const NEXT = bump(BUNDLED);
const AFTER = bump(BUNDLED, 2);
const HASH = "a".repeat(64);
const goodLock = (version: string) => `# made by make_lock.py\nanyio==4.9.0 \\\n    --hash=sha256:${HASH}\ncffi==2.1.1 ; platform_python_implementation != 'PyPy' \\\n    --hash=sha256:${HASH}\ncasper-network-mcp==${version} --hash=sha256:${HASH}\n`;

interface FakeRelease { tag: string; prerelease?: boolean; draft?: boolean; lock?: string | false }

/** GitHub as far as Casper uses it: GET /repos/<repo>/releases and GET /download/<tag>/casper-network-mcp.lock.txt. */
function fakeGitHub(releases: FakeRelease[]) {
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      requests.push(url.pathname);
      if (url.pathname === "/api/releases") {
        return Response.json(releases.map((release) => ({
          tag_name: release.tag, draft: release.draft ?? false, prerelease: release.prerelease ?? false, body: "notes",
          assets: release.lock === false ? [{ name: "casper_network_mcp.whl" }] : [{ name: "casper-network-mcp.lock.txt" }, { name: "casper_network_mcp.whl" }],
        })));
      }
      const match = /^\/download\/([^/]+)\/casper-network-mcp\.lock\.txt$/.exec(url.pathname);
      const release = match ? releases.find((item) => item.tag === match[1]) : undefined;
      if (release && typeof release.lock === "string") return new Response(release.lock);
      return new Response("not found", { status: 404 });
    },
  });
  cleanup.push(() => server.stop(true));
  const base = `http://127.0.0.1:${server.port}`;
  const options = (extra: Partial<NetworkReleaseOptions> = {}): NetworkReleaseOptions => ({
    apiUrl: `${base}/api/releases`, downloadsUrl: `${base}/download`, fetch: (url, init) => fetch(url, init), ...extra,
  });
  return { requests, options, apiCalls: () => requests.filter((request) => request === "/api/releases").length };
}

/** A fake uv on PATH and a runner whose `pip install` writes the server's program; records each lock it installs from. */
async function fakeInstall() {
  const bin = await temp("casper-releases-uv-");
  await fakeProgram(path.join(bin, "uv"), "process.exit(0);");
  const locks: string[] = [];
  const run: ToolRunner = async (call) => {
    if (call.args[0] === "pip") {
      locks.push(await readFile(call.args.at(-1)!, "utf8"));
      const python = call.args[call.args.indexOf("--python") + 1]!;
      await mkdir(path.dirname(python), { recursive: true });
      await writeFile(path.join(path.dirname(python), process.platform === "win32" ? `${NETWORK_SERVER.source.entry}.exe` : NETWORK_SERVER.source.entry), "");
    }
    return { exitCode: 0, signal: null, stdout: "", stderr: "" };
  };
  return { env: { PATH: bin }, run, locks };
}

async function writeMcp(home: string, servers: Record<string, unknown>): Promise<void> {
  await mkdir(path.join(home, ".casper"), { recursive: true });
  await writeFile(path.join(home, ".casper/mcp.json"), JSON.stringify({ mcpServers: servers }, null, 2));
}

/** Casper's own entry with `installed` in place, and a setup host that answers `answers`. */
async function setup(installed: string | undefined, releases: NetworkReleaseOptions, answers: string[] = []) {
  const homeDir = await temp("casper-releases-home-");
  const install = await fakeInstall();
  const options = { homeDir, env: install.env, run: install.run };
  if (installed) {
    const spec: LockedSpec = { ...NETWORK_SERVER, version: installed };
    expect((await installLockedSpec(spec, options)).ok).toBe(true);
    await writeMcp(homeDir, { network: networkServerEntry(homeDir) });
  }
  install.locks.length = 0;
  let output = "";
  const asked: string[] = [];
  const host: SetupHost = {
    homeDir, canAsk: () => true, releases,
    write: (text) => { output += text; },
    chooseAnswer: async (preview) => { asked.push(preview); return answers.shift(); },
    configured: async () => (await discoverMCPConfiguration({ projectRoot: homeDir, homeDir, platform: "linux" })).servers,
    connect: async () => ({ ok: true }),
    restart: async (_name, whileStopped) => { await whileStopped?.(); },
    install: { env: install.env, run: install.run },
  };
  return { host, homeDir, locks: install.locks, output: () => output, asked };
}

test("a newer release is offered as an update and installed from the lock attached to that release", async () => {
  const github = fakeGitHub([{ tag: `v${NEXT}`, lock: goodLock(NEXT) }, { tag: `v${BUNDLED}`, lock: goodLock(BUNDLED) }]);
  const { host, homeDir, locks, output, asked } = await setup(BUNDLED, github.options(), ["2"]);
  const before = await readFile(path.join(homeDir, ".casper/mcp.json"), "utf8");
  // Nothing known before the check: the offer never waits on GitHub.
  expect(await networkSetupLine(homeDir, await host.configured(), host.releases)).toBeUndefined();
  await refreshNetworkReleases(homeDir, host.releases);
  const configured = await host.configured();
  expect(await shouldOfferNetworkUpdate(homeDir, configured, host.releases)).toEqual({ from: BUNDLED, to: NEXT });
  expect(await networkSetupLine(homeDir, configured, host.releases)).toBe(`network: update ready (${BUNDLED} → ${NEXT}) — /mcp setup network`);
  expect(await runNetworkUpdate(host, { explicit: false })).toBe("updated");
  expect(asked[0]).toContain(`Casper's network server has an update (${BUNDLED} → ${NEXT}, about ${NETWORK_SERVER.approxMB} MB from pypi.org).`);
  expect(asked[0]).toContain(`${NEXT} is newer than the one this Casper ships with (${BUNDLED}); its hash lock comes from that release on github.com and is checked first.`);
  expect(locks).toEqual([goodLock(NEXT)]);
  expect(github.requests).toContain(`/download/v${NEXT}/casper-network-mcp.lock.txt`);
  expect(await installedVersion(homeDir, NETWORK_SERVER)).toBe(NEXT);
  expect(output()).toContain(`Network server updated to ${NEXT}.`);
  expect(await readFile(path.join(homeDir, ".casper/mcp.json"), "utf8")).toBe(before);
  // Now current: nothing more to offer.
  expect(await networkSetupLine(homeDir, configured, host.releases)).toBeUndefined();
});

test("Not now is kept for that release; a later release is asked about again", async () => {
  const github = fakeGitHub([{ tag: `v${NEXT}`, lock: goodLock(NEXT) }]);
  const { host, homeDir } = await setup(BUNDLED, github.options(), ["1"]);
  await refreshNetworkReleases(homeDir, host.releases);
  expect(await runNetworkUpdate(host, { explicit: false })).toBe("not-now");
  expect(await shouldOfferNetworkUpdate(homeDir, await host.configured(), host.releases)).toBeUndefined();
  expect(await installedVersion(homeDir, NETWORK_SERVER)).toBe(BUNDLED);
  const later = fakeGitHub([{ tag: `v${AFTER}`, lock: goodLock(AFTER) }]);
  await refreshNetworkReleases(homeDir, later.options({ now: () => Date.now() + RELEASE_CHECK_EVERY_MS + 1 }));
  expect(await shouldOfferNetworkUpdate(homeDir, await host.configured(), host.releases)).toEqual({ from: BUNDLED, to: AFTER });
});

test("the same or an older release is never offered: no downgrade", async () => {
  const github = fakeGitHub([{ tag: `v${BUNDLED}`, lock: goodLock(BUNDLED) }, { tag: "v0.0.1", lock: goodLock("0.0.1") }]);
  const { host, homeDir } = await setup(BUNDLED, github.options());
  await refreshNetworkReleases(homeDir, host.releases);
  expect(await networkSetupLine(homeDir, await host.configured(), host.releases)).toBeUndefined();
  expect(await runNetworkUpdate(host, { explicit: false })).toBe("current");
  // Installed newer than any release (a newer Casper put it there): kept.
  const ahead = await setup(AFTER, github.options());
  await refreshNetworkReleases(ahead.homeDir, ahead.host.releases);
  expect(await newerNetworkRelease(ahead.homeDir, AFTER, ahead.host.releases)).toBeUndefined();
  expect(await runNetworkUpdate(ahead.host, { explicit: false })).toBe("current");
});

test("a pre-release is skipped, unless the installed version is itself a pre-release; drafts and releases with no lock never count", async () => {
  const github = fakeGitHub([
    { tag: `v${AFTER}`, prerelease: true, lock: goodLock(AFTER) }, { tag: `v${bump(BUNDLED, 3)}`, draft: true, lock: goodLock(bump(BUNDLED, 3)) },
    { tag: `v${bump(BUNDLED, 4)}`, lock: false }, { tag: `v${NEXT}`, prerelease: true, lock: goodLock(NEXT) },
  ]);
  const { host, homeDir } = await setup(BUNDLED, github.options());
  await refreshNetworkReleases(homeDir, host.releases);
  expect(await newerNetworkRelease(homeDir, BUNDLED, host.releases)).toBeUndefined();
  expect(await networkSetupLine(homeDir, await host.configured(), host.releases)).toBeUndefined();
  // On the NEXT pre-release already: the newer pre-release is offered.
  expect(await newerNetworkRelease(homeDir, NEXT, host.releases)).toBe(AFTER);
});

test("a malformed version is never used: not in a URL, a path or a command", async () => {
  expect(installableReleases([
    { tag_name: "v1.2.3; rm -rf ~", assets: [{ name: "casper-network-mcp.lock.txt" }] },
    { tag_name: "v../../../etc", assets: [{ name: "casper-network-mcp.lock.txt" }] },
    { tag_name: "v1.2.3-rc1", assets: [{ name: "casper-network-mcp.lock.txt" }] },
    { tag_name: "latest", assets: [{ name: "casper-network-mcp.lock.txt" }] },
    { tag_name: `v${"9".repeat(40)}.0`, assets: [{ name: "casper-network-mcp.lock.txt" }] },
    { tag_name: 7, assets: [{ name: "casper-network-mcp.lock.txt" }] },
    { tag_name: "v1.2.3", assets: [{ name: "casper-network-mcp.lock.txt" }] },
  ])).toEqual([{ version: "1.2.3", prerelease: false }]);
  expect(installableReleases({ message: "API rate limit exceeded" })).toEqual([]);
  for (const bad of ["1.2.3/../x", "1.2", "1", "1.2.3.4.5", "1.2.3 ", "v1.2.3", ""]) expect(validReleaseVersion(bad)).toBe(bad === "1.2");
  let fetched = 0;
  expect(await fetchReleaseLock("1.2.3/../../x", { fetch: async () => { fetched++; return new Response(""); } })).toEqual({ ok: false, reason: "its version isn't digits and dots" });
  expect(fetched).toBe(0);
  // A saved check edited by hand is read as untrusted too.
  const home = await temp("casper-releases-saved-");
  await mkdir(path.join(home, ".casper"), { recursive: true });
  await writeFile(path.join(home, ".casper/network-releases.json"), JSON.stringify({ checkedAt: Date.now(), releases: [{ version: "9.9.9 && evil", prerelease: false }, { version: "../9", prerelease: false }] }));
  expect(await newerNetworkRelease(home, BUNDLED, {})).toBeUndefined();
});

test("checkLock: the release's own hashed line, pinned requirements and hashes only", () => {
  expect(() => checkLock(goodLock(NEXT), NEXT)).not.toThrow();
  expect(() => checkLock(NETWORK_SERVER.source.lock, BUNDLED)).not.toThrow();
  expect(() => checkLock(goodLock(NEXT), AFTER)).toThrow(`the lock has no hashed casper-network-mcp==${AFTER} line`);
  expect(() => checkLock(`casper-network-mcp==${NEXT}\n`, NEXT)).toThrow("no hashed");
  expect(() => checkLock(`${goodLock(NEXT)}-e ./src\n`, NEXT)).toThrow("the lock has a local project line");
  expect(() => checkLock(`${goodLock(NEXT)}.\n`, NEXT)).toThrow("the lock has a local project line");
  expect(() => checkLock(`--index-url https://pypi.example.invalid/simple\n${goodLock(NEXT)}`, NEXT)).toThrow("the lock has an option line");
  expect(() => checkLock(`${goodLock(NEXT)}--find-links /tmp/wheels\n`, NEXT)).toThrow("the lock has an option line");
  expect(() => checkLock(`${goodLock(NEXT)}evil @ https://example.invalid/evil.whl --hash=sha256:${HASH}\n`, NEXT)).toThrow("isn't pinned to one version");
  expect(() => checkLock(`${goodLock(NEXT)}evil>=1.0 --hash=sha256:${HASH}\n`, NEXT)).toThrow("isn't pinned to one version");
});

test("a bad release lock is refused and said plainly; the bundled version is installed when it is newer, else nothing changes", async () => {
  const noHash = fakeGitHub([{ tag: `v${NEXT}`, lock: `casper-network-mcp==${NEXT}\n` }]);
  const older = await setup("0.0.9", noHash.options(), ["2"]);
  await refreshNetworkReleases(older.homeDir, older.host.releases);
  expect(await shouldOfferNetworkUpdate(older.homeDir, await older.host.configured(), older.host.releases)).toEqual({ from: "0.0.9", to: NEXT });
  expect(await runNetworkUpdate(older.host, { explicit: false })).toBe("updated");
  expect(older.output()).toContain(`casper-network-mcp ${NEXT} wasn't installed: its lock failed Casper's check: the lock has no hashed casper-network-mcp==${NEXT} line.`);
  expect(older.output()).toContain(`Casper installs the version it ships with, ${BUNDLED}, instead.`);
  expect(older.output()).toContain(`Network server updated to ${BUNDLED}.`);
  expect(older.locks).toEqual([NETWORK_SERVER.source.lock]);
  expect(await installedVersion(older.homeDir, NETWORK_SERVER)).toBe(BUNDLED);
  // A lock that failed the check isn't offered again at start.
  expect(await shouldOfferNetworkUpdate(older.homeDir, await older.host.configured(), older.host.releases)).toBeUndefined();

  const localLine = fakeGitHub([{ tag: `v${NEXT}`, lock: `${goodLock(NEXT)}-e .\n` }]);
  const current = await setup(BUNDLED, localLine.options(), ["2"]);
  await refreshNetworkReleases(current.homeDir, current.host.releases);
  expect(await runNetworkUpdate(current.host, { explicit: false })).toBe("failed");
  expect(current.output()).toContain(`casper-network-mcp ${NEXT} wasn't installed: its lock failed Casper's check: the lock has a local project line.\nThe network server keeps ${BUNDLED}.\n`);
  expect(current.locks).toEqual([]);
  expect(await installedVersion(current.homeDir, NETWORK_SERVER)).toBe(BUNDLED);
  expect(await shouldOfferNetworkUpdate(current.homeDir, await current.host.configured(), current.host.releases)).toBeUndefined();
  expect(await runNetworkUpdate(current.host, { explicit: false })).toBe("not-now");

  // No network when installing: the same plain words.
  const gone = await setup(BUNDLED, { ...localLine.options(), fetch: async () => { throw new Error("Unable to connect"); } }, ["2"]);
  await writeFile(path.join(gone.homeDir, ".casper/network-releases.json"), JSON.stringify({ checkedAt: Date.now(), releases: [{ version: NEXT, prerelease: false }] }));
  expect(await runNetworkUpdate(gone.host, { explicit: false })).toBe("failed");
  expect(gone.output()).toContain(`casper-network-mcp ${NEXT} wasn't installed: its lock couldn't be downloaded (Unable to connect).\nThe network server keeps ${BUNDLED}.`);
  // A download that failed is asked about again: it may work next time.
  expect(await shouldOfferNetworkUpdate(gone.homeDir, await gone.host.configured(), gone.host.releases)).toEqual({ from: BUNDLED, to: NEXT });
});

test("a first setup installs the newest known release; with a bad lock it says so and installs the bundled one", async () => {
  const github = fakeGitHub([{ tag: `v${NEXT}`, lock: goodLock(NEXT) }]);
  const fresh = await setup(undefined, github.options(), ["2"]);
  await refreshNetworkReleases(fresh.homeDir, fresh.host.releases);
  expect(await runNetworkSetup(fresh.host, { explicit: true })).toBe("installed");
  expect(fresh.asked[0]).toContain(`Casper can set up its network server (casper-network-mcp ${NEXT},`);
  expect(await installedVersion(fresh.homeDir, NETWORK_SERVER)).toBe(NEXT);

  const bad = fakeGitHub([{ tag: `v${NEXT}`, lock: "nothing here\n" }]);
  const fallback = await setup(undefined, bad.options(), ["2"]);
  await refreshNetworkReleases(fallback.homeDir, fallback.host.releases);
  expect(await runNetworkSetup(fallback.host, { explicit: true })).toBe("installed");
  expect(fallback.output()).toContain(`Casper installs the version it ships with, ${BUNDLED}, instead.`);
  expect(await installedVersion(fallback.homeDir, NETWORK_SERVER)).toBe(BUNDLED);
});

test("CASPER_OFFLINE=1, tools.downloads off and network_updates off never fetch and never offer a release", async () => {
  expect(networkReleasesOff({ CASPER_OFFLINE: "1" }, {})).toBe("CASPER_OFFLINE=1");
  expect(networkReleasesOff({}, undefined)).toBe("settings didn't load");
  expect(networkReleasesOff({}, { toolDownloads: false })).toBe("tools: { downloads: off }");
  expect(networkReleasesOff({}, { networkUpdates: false })).toBe("network_updates: off");
  expect(networkReleasesOff({}, {})).toBeUndefined();
  const github = fakeGitHub([{ tag: `v${NEXT}`, lock: goodLock(NEXT) }]);
  for (const off of ["CASPER_OFFLINE=1", "tools: { downloads: off }", "network_updates: off"]) {
    const { host, homeDir } = await setup(BUNDLED, github.options({ off }), ["2"]);
    await refreshNetworkReleases(homeDir, host.releases);
    // A release found before the switch was turned off isn't offered either.
    await writeFile(path.join(homeDir, ".casper/network-releases.json"), JSON.stringify({ checkedAt: Date.now(), releases: [{ version: NEXT, prerelease: false }] }));
    expect(await networkSetupLine(homeDir, await host.configured(), host.releases)).toBeUndefined();
    expect(await runNetworkUpdate(host, { explicit: true })).toBe("current");
  }
  expect(github.requests).toEqual([]);
});

test("GitHub is asked at most once a day; a failed check keeps what was known and also waits a day", async () => {
  const github = fakeGitHub([{ tag: `v${NEXT}`, lock: goodLock(NEXT) }]);
  const home = await temp("casper-releases-daily-");
  let now = 1_000_000;
  const options = github.options({ now: () => now });
  await refreshNetworkReleases(home, options);
  await refreshNetworkReleases(home, options);
  now += RELEASE_CHECK_EVERY_MS - 1;
  await refreshNetworkReleases(home, options);
  expect(github.apiCalls()).toBe(1);
  now += 2;
  await refreshNetworkReleases(home, options);
  expect(github.apiCalls()).toBe(2);
  // GitHub unreachable the next day: the release found before still counts, and no retry until tomorrow.
  now += RELEASE_CHECK_EVERY_MS;
  let failed = 0;
  const unreachable = { ...options, fetch: async () => { failed++; throw new Error("Unable to connect"); } };
  await refreshNetworkReleases(home, unreachable);
  await refreshNetworkReleases(home, unreachable);
  expect(failed).toBe(1);
  expect(await newerNetworkRelease(home, BUNDLED, options)).toBe(NEXT);
});

test("a dev entry (uv run --directory <checkout>) or any other entry is never updated or checked for", async () => {
  const github = fakeGitHub([{ tag: `v${NEXT}`, lock: goodLock(NEXT) }]);
  const { host, homeDir, locks } = await setup(BUNDLED, github.options(), ["2"]);
  await refreshNetworkReleases(homeDir, host.releases);
  const dev = { command: "uv", args: ["run", "--directory", "/path/to/casper-network-mcp", "casper-network-mcp"], env: {} };
  await writeMcp(homeDir, { network: dev });
  const before = await readFile(path.join(homeDir, ".casper/mcp.json"), "utf8");
  const configured = await host.configured();
  expect(configured.some((definition) => isCaspersEntry(definition, homeDir))).toBe(false);
  expect(await shouldOfferNetworkUpdate(homeDir, configured, host.releases)).toBeUndefined();
  expect(await networkSetupLine(homeDir, configured, host.releases)).toBeUndefined();
  expect(await runNetworkUpdate(host, { explicit: true })).toBe("current");
  expect(await runNetworkSetup(host, { explicit: true })).toBe("exists");
  expect(locks).toEqual([]);
  expect(await readFile(path.join(homeDir, ".casper/mcp.json"), "utf8")).toBe(before);
});

test("the hosts Casper names for releases are the ones it reaches", () => {
  expect(NETWORK_RELEASE_HOSTS).toEqual(["api.github.com", "github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]);
});
