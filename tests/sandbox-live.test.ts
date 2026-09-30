import { afterAll, beforeAll, expect } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { linuxSandboxProblem } from "../src/sandbox/linux";
import { ShellSandbox, type HostAnswer } from "../src/sandbox/manager";
import { runtimeEngine } from "../src/sandbox/runtime";
import { needsSandbox, sandboxAvailable } from "./support/platform";

/**
 * The real sandbox on this machine (bubblewrap on Linux, sandbox-exec on macOS). Skipped where it can't run;
 * Linux and macOS CI install what it needs, so there it always runs.
 */

let base = "", home = "", root = "", outside = "";
let sandbox: ShellSandbox;
const notes: string[] = [];
let answer: HostAnswer | undefined;
let server: Server | undefined;
let port = 0;
/** Another loopback address: not on the listed hosts, so reaching it needs an answer. */
const UNLISTED = "127.0.0.2";

// A machine proxy (CI or a company proxy) would carry the allowed request away from this host's test server.
const PROXY_NAMES = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"];
const savedProxy = Object.fromEntries(PROXY_NAMES.map((name) => [name, process.env[name]]));

beforeAll(async () => {
  if (!sandboxAvailable) return;
  for (const name of PROXY_NAMES) delete process.env[name];
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-sandbox-live-")));
  home = path.join(base, "home"); root = path.join(base, "project"); outside = path.join(base, "outside");
  await mkdir(path.join(home, ".ssh"), { recursive: true });
  await writeFile(path.join(home, ".ssh", "id_test"), "PRIVATE-KEY-MARKER\n");
  await mkdir(path.join(home, ".casper", "projects", "p"), { recursive: true });
  await writeFile(path.join(home, ".casper", "projects", "p", "security-approved.json"), "{}\n");
  await mkdir(outside, { recursive: true });
  await mkdir(root, { recursive: true });
  const git = Bun.spawnSync(["git", "init", "-q", root]);
  expect(git.exitCode).toBe(0);
  sandbox = new ShellSandbox({
    root: () => root, home, tempDirs: [], engine: runtimeEngine(), problem: () => process.platform === "linux" ? linuxSandboxProblem() : undefined,
    askHost: () => answer === undefined ? undefined : Promise.resolve(answer), note: (line) => notes.push(line),
  });
  server = createServer((_request, response) => { response.end("hello from the host\n"); });
  await new Promise<void>((resolve) => server!.listen(0, "0.0.0.0", resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  for (const [name, value] of Object.entries(savedProxy)) if (value !== undefined) process.env[name] = value;
  await sandbox?.close();
  await new Promise((resolve) => server ? server.close(resolve) : resolve(undefined));
  if (base) await rm(base, { recursive: true, force: true });
});

async function run(command: string, network: "ask" | "host" | "none" = "ask") {
  const wrapped = await sandbox.wrap(command, { cwd: root, network });
  expect(wrapped.held).toBe(true);
  return new Promise<{ code: number | null; out: string; id: string }>((resolve) => {
    const child = spawn(wrapped.command, { cwd: root, shell: true, env: { ...process.env, HOME: home } });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { out += chunk; });
    child.on("close", (code) => resolve({ code, out, id: wrapped.id }));
  });
}

needsSandbox("a command can write the project but nothing outside it", async () => {
  expect((await run("echo inside > inside.txt")).code).toBe(0);
  expect(await readFile(path.join(root, "inside.txt"), "utf8")).toBe("inside\n");
  const refused = await run(`echo x > ${outside}/escape.txt`);
  expect(refused.code).not.toBe(0);
  expect(await readdir(outside)).toEqual([]);
});

needsSandbox("private places and Casper's approvals can't be read", async () => {
  const key = await run(`cat ${home}/.ssh/id_test`);
  expect(key.code).not.toBe(0);
  expect(key.out).not.toContain("PRIVATE-KEY-MARKER");
  expect((await run(`cat ${home}/.casper/projects/p/security-approved.json`)).code).not.toBe(0);
});

needsSandbox("git's own files stay read-only: no hook, no core.hooksPath", async () => {
  expect((await run("echo 'touch pwned' > .git/hooks/pre-commit")).code).not.toBe(0);
  expect(existsSync(path.join(root, ".git", "hooks", "pre-commit"))).toBe(false);
  expect((await run("git config core.hooksPath /tmp/hooks")).code).not.toBe(0);
  expect(await readFile(path.join(root, ".git", "config"), "utf8")).not.toContain("hooksPath");
});

needsSandbox("a refused write is named: blocked by the sandbox (wanted to write ...)", async () => {
  const result = await run(`echo x > ${outside}/named.txt`);
  expect(result.code).not.toBe(0);
  // The monitor reports shortly after the command ends.
  let reason: string | undefined;
  for (let attempt = 0; attempt < 40 && !reason?.includes("named.txt"); attempt++) {
    reason = sandbox.blockedReason(result.id, result.out);
    if (!reason?.includes("named.txt")) await Bun.sleep(50);
  }
  expect(reason).toBe(`blocked by the sandbox (wanted to write ${outside}/named.txt)`);
});

needsSandbox("a host that is not listed is blocked when nobody can answer, and says so once", async () => {
  answer = undefined;
  const result = await run(`curl -sS -m 10 --noproxy '' http://${UNLISTED}:${port}/`);
  expect(result.out).not.toContain("hello from the host");
  expect(notes.filter((line) => line.startsWith(`[sandbox] Blocked ${UNLISTED}`))).toHaveLength(1);
});

needsSandbox("a host you allow for the session is reached", async () => {
  answer = "session";
  const result = await run(`curl -sS -m 10 --noproxy '' http://${UNLISTED}:${port}/`);
  expect(result.out).toContain("hello from the host");
  answer = undefined;
});

needsSandbox("no network at all for a tool run with network none; files still held", async () => {
  const result = await run(`curl -sS -m 5 http://127.0.0.1:${port}/`, "none");
  expect(result.out).not.toContain("hello from the host");
  expect((await run(`echo x > ${outside}/none.txt`, "none")).code).not.toBe(0);
  expect((await run(`cat ${home}/.ssh/id_test`, "none")).out).not.toContain("PRIVATE-KEY-MARKER");
});

needsSandbox("a dev server's command (network host) is reached from the host, files still held", async () => {
  const result = await run(`curl -sS -m 5 http://127.0.0.1:${port}/`, "host");
  expect(result.out).toContain("hello from the host");
  expect((await run(`echo x > ${outside}/host.txt`, "host")).code).not.toBe(0);
  expect((await run(`cat ${home}/.ssh/id_test`, "host")).out).not.toContain("PRIVATE-KEY-MARKER");
});
