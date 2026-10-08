import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { linuxSandboxProblem } from "../src/sandbox/linux";
import { ShellSandbox, type HostAnswer } from "../src/sandbox/manager";
import { runtimeEngine } from "../src/sandbox/runtime";
import { useSandbox } from "../src/sandbox/manager";
import { runCommandCheck } from "../src/verify/command";
import { needsSandbox, sandboxAvailable } from "./support/platform";
import { removeTempDir } from "./support/temp-dir";

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
  // macOS answers only 127.0.0.1 until the others are added to lo0 (macOS CI does); without it a request there
  // hangs instead of reaching this test's server.
  if (process.platform === "darwin" && !Object.values(os.networkInterfaces()).flat().some((entry) => entry?.address === UNLISTED)) {
    throw new Error(`${UNLISTED} is not on lo0: sudo ifconfig lo0 alias ${UNLISTED} up`);
  }
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
  if (base) await removeTempDir(base);
});

async function run(command: string, network: "ask" | "host" | "none" = "ask", readOnlyProject = false) {
  const wrapped = await sandbox.wrap(command, { cwd: root, network, ...(readOnlyProject ? { readOnlyProject } : {}) });
  expect(wrapped.held).toBe(true);
  return new Promise<{ code: number | null; out: string; id: string }>((resolve) => {
    const child = spawn(wrapped.command, { cwd: root, shell: true, env: { ...process.env, HOME: home } });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { out += chunk; });
    child.on("close", (code) => { sandbox.finished(wrapped.id); resolve({ code, out, id: wrapped.id }); });
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

/**
 * macOS names a refused write only through `log stream` (the runtime's monitor). macOS lets only admin accounts
 * run it ("log: Must be admin to run 'stream' command"), so on a standard account nothing can be named: skip there.
 */
const sandboxLogRefused = sandboxAvailable && process.platform === "darwin"
  && Bun.spawnSync(["/usr/bin/log", "stream", "--style", "compact"], { timeout: 1000, stdout: "ignore", stderr: "pipe" })
    .stderr.toString().includes("Must be admin");

test.skipIf(!sandboxAvailable || sandboxLogRefused)("a refused write is named: blocked by the sandbox (wanted to write ...)", async () => {
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

needsSandbox("a command that reaches out at once waits for the sandbox's proxy, even when it starts slowly (Linux)", async () => {
  if (process.platform !== "linux") return;
  // A socat that takes a moment to start, as on a loaded machine: the request must still reach the proxy.
  const slow = path.join(base, "slow-socat");
  await mkdir(slow, { recursive: true });
  const real = Bun.which("socat")!;
  await writeFile(path.join(slow, "socat"), `#!/bin/sh\nsleep 0.6\nexec ${real} "$@"\n`, { mode: 0o755 });
  answer = undefined;
  const wrapped = await sandbox.wrap(`curl -sS -m 10 --noproxy '' http://127.0.0.3:${port}/`, { cwd: root, network: "ask" });
  // Not spawnSync: the proxy answers from this process, so the event loop must keep running.
  const child = Bun.spawn(["sh", "-c", wrapped.command], { cwd: root, env: { ...process.env, HOME: home, PATH: `${slow}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(child.stdout).text();
  await child.exited;
  sandbox.finished(wrapped.id);
  expect(out).toContain("Connection blocked by network allowlist");
  expect(notes.filter((line) => line.startsWith("[sandbox] Blocked 127.0.0.3"))).toHaveLength(1);
});

needsSandbox("a host you allow for the session is reached", async () => {
  answer = "session";
  const result = await run(`curl -sS -m 10 --noproxy '' http://${UNLISTED}:${port}/`);
  expect(result.out).toContain("hello from the host");
  answer = undefined;
});

needsSandbox("a host you said yes to for one ssh command is reached through the sandbox's ssh route, only while that command runs", async () => {
  // ssh in the sandbox connects through the runtime's ProxyCommand (the one git over ssh uses). Run that route with the
  // %h and %p ssh would fill in, to a stand-in ssh server that sends its greeting first, as sshd does. Nobody can
  // answer here, so only the yes for this one command lets it through. macOS's route is nc through the SOCKS proxy,
  // which can't send the proxy's password, so there ssh in the sandbox is refused and Casper says so.
  if (process.platform !== "linux") return;
  const target = "127.0.0.4";
  const sshd = createNetServer({ allowHalfOpen: true }, (connection) => { connection.end("SSH-2.0-CasperFixture\r\n"); });
  await new Promise<void>((resolve) => sshd.listen(0, "0.0.0.0", resolve));
  const sshPort = (sshd.address() as { port: number }).port;
  const route = `pc=$(printf %s "$GIT_SSH_COMMAND" | sed -n "s/.*ProxyCommand='\\([^']*\\)'.*/\\1/p" | sed "s/%h/${target}/; s/%p/${sshPort}/; s/^socat /socat -t 10 /"); `
    + `test -n "$pc" || { echo no-ssh-route; exit 9; }; sh -c "$pc" </dev/null 2>&1`;
  const attempt = async (allowed: boolean) => {
    const wrapped = await sandbox.wrap(route, { cwd: root, network: "ask" });
    if (allowed) sandbox.allowForRun(wrapped.id, [target]);
    return new Promise<string>((resolve) => {
      const child = spawn(wrapped.command, { cwd: root, shell: true, env: { ...process.env, HOME: home } });
      let out = "";
      child.stdout.on("data", (chunk) => { out += chunk; });
      child.stderr.on("data", (chunk) => { out += chunk; });
      child.on("close", () => { sandbox.finished(wrapped.id); resolve(out); });
    });
  };
  try {
    expect(await attempt(true)).toContain("SSH-2.0-CasperFixture");
    expect(await attempt(false)).not.toContain("SSH-2.0-CasperFixture");
  } finally { await new Promise((resolve) => sshd.close(resolve)); }
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

needsSandbox("the AI's shell can't change your approvals or lab answers in ~/.casper", async () => {
  const approvals = `${home}/.casper/projects/p/security-approved.json`;
  expect((await run(`echo '{"markers":[]}' > ${approvals}`)).code).not.toBe(0);
  expect((await run(`echo '{}' > ${home}/.casper/projects/p/lab-always.json`)).code).not.toBe(0);
  expect(await readFile(approvals, "utf8")).toBe("{}\n");
  expect(existsSync(path.join(home, ".casper", "projects", "p", "lab-always.json"))).toBe(false);
});

needsSandbox("during a plan turn the project is read-only too, so a repo's git diff program can't change it", async () => {
  // A repository's own diff.external runs a program; while planning it can't write the project.
  const script = path.join(root, "differ.sh");
  await writeFile(script, "#!/bin/sh\necho pwned > planned.txt\n", { mode: 0o755 });
  Bun.spawnSync(["git", "-C", root, "add", "-A"]);
  Bun.spawnSync(["git", "-C", root, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "base"]);
  await writeFile(path.join(root, "inside.txt"), "changed\n");
  await run(`git -c diff.external=${script} diff`, "ask", true);
  expect(existsSync(path.join(root, "planned.txt"))).toBe(false);
  expect((await run("echo x > plan-write.txt", "ask", true)).code).not.toBe(0);
  expect(existsSync(path.join(root, "plan-write.txt"))).toBe(false);
});

needsSandbox("no command can reach a Unix socket on the host (Docker, the session bus, an SSH agent), in any network mode", async () => {
  if (process.platform !== "linux") return; // macOS allows only the sockets you list (sandbox.allowUnixSockets).
  const socket = path.join(outside, "agent.sock");
  const listener = createNetServer((connection) => { connection.end("SOCKET-REACHED\n"); });
  await new Promise<void>((resolve) => listener.listen(socket, resolve));
  try {
    for (const network of ["ask", "host", "none"] as const) {
      const result = await run(`socat -T 5 - UNIX-CONNECT:${socket} </dev/null`, network);
      expect({ network, out: result.out.includes("SOCKET-REACHED") }).toEqual({ network, out: false });
      expect(result.code).not.toBe(0);
    }
  } finally { await new Promise((resolve) => listener.close(resolve)); }
});

needsSandbox("no command can move the project's .git aside and put another in its place, in any network mode", async () => {
  for (const network of ["ask", "host", "none"] as const) {
    const result = await run("mv .git .git-moved", network);
    expect({ network, code: result.code === 0 }).toEqual({ network, code: false });
    expect(existsSync(path.join(root, ".git", "config"))).toBe(true);
    expect(existsSync(path.join(root, ".git-moved"))).toBe(false);
  }
});

needsSandbox("after a check ends, the sandbox leaves no stand-in files (.bashrc, .gitconfig, .vscode) in your project", async () => {
  const project = path.join(base, "clean-after");
  expect(Bun.spawnSync(["git", "init", "-q", project]).exitCode).toBe(0);
  const checkSandbox = new ShellSandbox({ root: () => project, home, tempDirs: [], engine: runtimeEngine(), problem: () => process.platform === "linux" ? linuxSandboxProblem() : undefined });
  useSandbox(checkSandbox);
  // The runtime puts its stand-ins in Casper's own folder, which is the project when you start Casper there.
  const launched = process.cwd();
  process.chdir(project);
  try {
    const during = await runCommandCheck({ name: "test", command: "ls -A", cwd: project, timeoutMs: 20_000 });
    expect(during.status).toBe("pass");
    expect((await readdir(project)).sort()).toEqual([".git"]);
  } finally { process.chdir(launched); useSandbox(undefined); await checkSandbox.close(); }
});

needsSandbox("a submodule's git settings, hooks and .git file can't be changed, in any network mode", async () => {
  const project = path.join(base, "with-submodule");
  const modules = path.join(project, ".git", "modules", "lib");
  expect(Bun.spawnSync(["git", "init", "-q", project]).exitCode).toBe(0);
  await mkdir(path.dirname(modules), { recursive: true });
  expect(Bun.spawnSync(["git", "init", "-q", "--separate-git-dir", modules, path.join(project, "lib")]).exitCode).toBe(0);
  await writeFile(path.join(project, ".gitmodules"), '[submodule "lib"]\n\tpath = lib\n\turl = ./lib\n');
  const config = await readFile(path.join(modules, "config"), "utf8");
  const pointer = await readFile(path.join(project, "lib", ".git"), "utf8");
  const subSandbox = new ShellSandbox({ root: () => project, home, tempDirs: [], engine: runtimeEngine(), problem: () => process.platform === "linux" ? linuxSandboxProblem() : undefined });
  try {
    for (const network of ["ask", "host", "none"] as const) {
      const wrapped = await subSandbox.wrap(
        `git -C lib config core.fsmonitor 'touch ${outside}/ran'; mkdir -p .git/modules/lib/hooks; echo 'touch ${outside}/ran' > .git/modules/lib/hooks/post-checkout; echo "gitdir: ${outside}" > lib/.git`,
        { cwd: project, network },
      );
      Bun.spawnSync(["sh", "-c", wrapped.command], { cwd: project, env: { ...process.env, HOME: home } });
      subSandbox.finished(wrapped.id);
      expect({ network, config: await readFile(path.join(modules, "config"), "utf8") === config }).toEqual({ network, config: true });
      expect({ network, hook: existsSync(path.join(modules, "hooks", "post-checkout")) }).toEqual({ network, hook: false });
      expect({ network, pointer: await readFile(path.join(project, "lib", ".git"), "utf8") === pointer }).toEqual({ network, pointer: true });
    }
  } finally { await subSandbox.close(); }
});

needsSandbox("a worktree's .git file can't be pointed somewhere else", async () => {
  const tree = path.join(base, "worktree");
  Bun.spawnSync(["git", "-C", root, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "tree base"]);
  expect(Bun.spawnSync(["git", "-C", root, "worktree", "add", "-q", tree]).exitCode).toBe(0);
  const before = await readFile(path.join(tree, ".git"), "utf8");
  const treeSandbox = new ShellSandbox({ root: () => tree, home, tempDirs: [], engine: runtimeEngine(), problem: () => process.platform === "linux" ? linuxSandboxProblem() : undefined });
  try {
    for (const network of ["ask", "host", "none"] as const) {
      const wrapped = await treeSandbox.wrap(`echo "gitdir: ${outside}" > .git`, { cwd: tree, network });
      Bun.spawnSync(["sh", "-c", wrapped.command], { cwd: tree, env: { ...process.env, HOME: home } });
      treeSandbox.finished(wrapped.id);
      expect({ network, same: await readFile(path.join(tree, ".git"), "utf8") === before }).toEqual({ network, same: true });
    }
  } finally { await treeSandbox.close(); }
});

/** Running socat processes (not exited ones waiting to be reaped), with their parents. */
function runningSocat(): { pid: number; parent: number }[] {
  const listing = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,stat=,comm="], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C" } });
  return listing.stdout.toString().split("\n").map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields[3] === "socat" && !fields[2]!.startsWith("Z"))
    .map((fields) => ({ pid: Number(fields[0]), parent: Number(fields[1]) }));
}

// On Linux the runtime relays the network through socat processes Casper starts; none may outlive the sandbox.
test.skipIf(!sandboxAvailable || process.platform !== "linux")("closing the sandbox, or Casper exiting, leaves no socat relay running", async () => {
  const project = path.join(base, "relays");
  expect(Bun.spawnSync(["git", "init", "-q", project]).exitCode).toBe(0);
  const relaySandbox = new ShellSandbox({ root: () => project, home, tempDirs: [], engine: runtimeEngine(), problem: () => linuxSandboxProblem() });
  let relays: number[] = [];
  try {
    const wrapped = await relaySandbox.wrap("true", { cwd: project, network: "ask" });
    expect(Bun.spawnSync(["sh", "-c", wrapped.command], { cwd: project, env: { ...process.env, HOME: home } }).exitCode).toBe(0);
    relaySandbox.finished(wrapped.id);
    relays = runningSocat().filter((item) => item.parent === process.pid).map((item) => item.pid);
    expect(relays.length).toBeGreaterThan(0);
  } finally { await relaySandbox.close(); }
  expect(runningSocat().filter((item) => relays.includes(item.pid))).toEqual([]);

  // A Casper process that exits without closing it (process.exit after an error) stops its relays on the way out.
  const script = path.join(base, "relay-exit.ts");
  await writeFile(script, `
    import { ShellSandbox } from ${JSON.stringify(path.resolve("src/sandbox/manager.ts"))};
    import { runtimeEngine } from ${JSON.stringify(path.resolve("src/sandbox/runtime.ts"))};
    const sandbox = new ShellSandbox({ root: () => ${JSON.stringify(project)}, home: ${JSON.stringify(home)}, tempDirs: [], engine: runtimeEngine() });
    const wrapped = await sandbox.wrap("true", { cwd: ${JSON.stringify(project)}, network: "ask" });
    Bun.spawnSync(["sh", "-c", wrapped.command], { cwd: ${JSON.stringify(project)} });
    console.log(Bun.spawnSync(["pgrep", "-P", String(process.pid), "-x", "socat"]).stdout.toString().trim().split("\\n").join(" "));
    process.exit(0);
  `);
  const child = Bun.spawnSync([process.execPath, script], { cwd: project, env: { ...process.env, HOME: home } });
  expect(child.exitCode).toBe(0);
  const exitedRelays = child.stdout.toString().trim().split(/\s+/).filter(Boolean).map(Number);
  expect(exitedRelays.length).toBeGreaterThan(0);
  let left = exitedRelays;
  for (let attempt = 0; attempt < 50 && left.length; attempt++) {
    await Bun.sleep(20);
    left = runningSocat().filter((item) => exitedRelays.includes(item.pid)).map((item) => item.pid);
  }
  expect(left).toEqual([]);
});

// Last: closing this second sandbox resets the runtime's shared proxy, which the tests above use.
test.skipIf(!sandboxAvailable || process.platform !== "darwin")("macOS: a /branch session's folder inside ~/.casper is writable, the rest of ~/.casper is not", async () => {
  const casper = path.join(home, ".casper");
  const session = path.join(casper, "worktrees", "key-one", "feature");
  const sibling = path.join(casper, "worktrees", "key-one", "other");
  await mkdir(session, { recursive: true });
  await mkdir(sibling, { recursive: true });
  await mkdir(path.join(casper, "agent"), { recursive: true });
  await writeFile(path.join(casper, "config.yaml"), "sandbox: on\n");
  const inSession = new ShellSandbox({ root: () => session, home, tempDirs: [], engine: runtimeEngine(), problem: () => undefined, note: (line) => notes.push(line) });
  try {
    const attempt = async (command: string) => {
      const wrapped = await inSession.wrap(command, { cwd: session, network: "none" });
      expect(wrapped.held).toBe(true);
      return new Promise<number | null>((resolve) => {
        const child = spawn(wrapped.command, { cwd: session, shell: true, env: { ...process.env, HOME: home } });
        child.on("close", (code) => { inSession.finished(wrapped.id); resolve(code); });
      });
    };
    expect(await attempt("echo made > made.txt && mkdir sub && echo more > sub/more.txt")).toBe(0);
    expect(await readFile(path.join(session, "sub", "more.txt"), "utf8")).toBe("more\n");
    for (const command of [`echo x >> ${casper}/config.yaml`, `echo x > ${casper}/agent/auth.json`, `echo x > ${sibling}/stolen.txt`]) {
      expect([command, await attempt(command)]).not.toEqual([command, 0]);
    }
    expect(await readFile(path.join(casper, "config.yaml"), "utf8")).toBe("sandbox: on\n");
    expect(existsSync(path.join(casper, "agent", "auth.json"))).toBe(false);
    expect(existsSync(path.join(sibling, "stolen.txt"))).toBe(false);
  } finally { await inSession.close(); }
});
