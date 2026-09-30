import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { linuxSandboxProblem } from "../../src/sandbox/linux";
import { ShellSandbox } from "../../src/sandbox/manager";
import { seccompHelper } from "../../src/sandbox/seccomp";

// A compiled probe: the sandbox runtime and its seccomp helper work from inside a standalone executable.
const [home, root] = [process.env.HOME!, process.argv[2]!];
const helper = await seccompHelper({ home });
const sandbox = new ShellSandbox({ root: () => root, home, tempDirs: [], problem: () => linuxSandboxProblem(), seccompPath: async () => helper });
await mkdir(path.join(home, ".ssh"), { recursive: true });
await writeFile(path.join(home, ".ssh", "id_probe"), "PROBE-KEY\n");
const run = async (command: string) => {
  const wrapped = await sandbox.wrap(command, { cwd: root });
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn(wrapped.command, { cwd: root, shell: true });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { out += chunk; });
    child.on("close", (code) => resolve({ code, out }));
  });
};
const inside = await run("echo inside > inside.txt && cat inside.txt");
const key = await run(`cat ${home}/.ssh/id_probe`);
const socket = await run("python3 -c \"import socket; socket.socket(socket.AF_UNIX)\" 2>/dev/null && echo SOCKET-OPEN || echo SOCKET-BLOCKED");
await sandbox.close();
const mode = helper ? (await stat(helper)).mode & 0o777 : 0;
const hash = helper ? createHash("sha256").update(await readFile(helper)).digest("hex") : "";
process.stdout.write(JSON.stringify({ helper, mode, hashInName: Boolean(helper && path.basename(helper).includes(hash.slice(0, 16))), inside: inside.out.trim(), key: key.out.includes("PROBE-KEY"), socket: socket.out.trim() }));
