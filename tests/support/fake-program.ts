import { setDefaultTimeout } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, copyFile, link, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FakeServerName } from "./fake-servers";

/**
 * Fake programs for tests, written in JavaScript so the same fake runs on every OS.
 *
 * On macOS and Linux a fake is a small sh script that runs `bun <name>.fake.cjs`. Windows has no #! line: Casper finds
 * programs there by PATHEXT and starts them without a shell, and Bun refuses to start a .cmd that way. So on Windows a
 * fake is <name>.exe, a hard link to one small Bun program (fake-launcher.ts, built once per change and kept in the
 * temp folder), which runs the <name>.fake.cjs next to it. Either way, argv reaches the script as it was given.
 *
 * The script is CommonJS. It starts with `fs`, `path`, `args` (the fake's arguments), `out(text)` and `err(text)`
 * (written at once, so nothing is lost on process.exit), `lines(list)` (each item and a newline), and
 * `fakeServer(name)`, which runs an MCP stand-in from tests/fixtures in this process (fake-servers.ts).
 */

const windows = process.platform === "win32";
const LAUNCHER = path.join(import.meta.dir, "fake-launcher.ts");
const SERVERS = path.join(import.meta.dir, "fake-servers.ts");
const FIXTURES = path.join(import.meta.dir, "..", "fixtures");
/** The files built into the launcher, and the lock file for the MCP SDK it builds in: a change to any of them builds a new one. */
const BUNDLED = [LAUNCHER, SERVERS, path.join(FIXTURES, "fake-network-mcp.ts"), path.join(FIXTURES, "mcp-network-server.ts"),
  path.join(import.meta.dir, "..", "..", "bun.lock")];

/** A program's file name on this OS: `name.exe` on Windows. */
export const programName = (name: string): string => windows && !/\.exe$/i.test(name) ? `${name}.exe` : name;

const exists = (file: string) => stat(file).then(() => true, () => false);

let built: Promise<string> | undefined;

/** The launcher .exe, built once for this source and this Bun, and shared by every test run on this PC. */
function launcher(): Promise<string> {
  built ??= (async () => {
    const hash = createHash("sha256").update(Bun.version).update(process.execPath);
    for (const file of BUNDLED) hash.update(await readFile(file));
    const folder = path.join(os.tmpdir(), "casper-test-fakes");
    const target = path.join(folder, `launcher-${hash.digest("hex").slice(0, 16)}.exe`);
    if (await exists(target)) return target;
    await mkdir(folder, { recursive: true });
    const partial = path.join(folder, `partial-${process.pid}-${Date.now()}.exe`);
    const build = Bun.spawnSync([process.execPath, "build", "--compile", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig",
      LAUNCHER, "--outfile", partial], { stdout: "pipe", stderr: "pipe" });
    if (build.exitCode !== 0) throw new Error(`Could not build the fake launcher:\n${build.stderr.toString()}`);
    // Another test run may have built it at the same time; either copy will do.
    try { await rename(partial, target); } catch (error) {
      await rm(partial, { force: true });
      if (!(await exists(target))) throw error;
    }
    return target;
  })();
  return built;
}

const PREAMBLE = [
  `const fs = require("node:fs");`,
  `const path = require("node:path");`,
  `const args = process.argv.slice(2);`,
  `const out = (text) => fs.writeSync(1, text);`,
  `const err = (text) => fs.writeSync(2, text);`,
  `const lines = (list) => list.map((line) => line + "\\n").join("");`,
  `const fakeServer = (name) => globalThis.fakeServer ? globalThis.fakeServer(name)`,
  `  : import(require("node:url").pathToFileURL(${JSON.stringify(SERVERS)}).href).then((servers) => servers.startFakeServer(name));`,
].join("\n");

/**
 * On Windows each MCP server stop reads the process table through PowerShell a few times (about half a second each),
 * so a test that starts and stops fake servers takes seconds there. Test files with such tests call this first.
 */
export function allowSlowServerStopsOnWindows(): void {
  if (windows) setDefaultTimeout(30_000);
}

/**
 * A fake MCP server program at `file` (".exe" is added on Windows): it sets `env`, runs `setup` (JavaScript, as in
 * fakeProgram), then runs tests/fixtures/<server>.ts. Returns the program's path.
 */
export function fakeServerProgram(file: string, server: FakeServerName,
  env: Record<string, string> = {}, setup = ""): Promise<string> {
  return fakeProgram(file, `Object.assign(process.env, ${JSON.stringify(env)});\n${setup}\nfakeServer(${JSON.stringify(server)});`);
}

/**
 * Write a fake program at `file` (".exe" is added on Windows) that runs `body`, and return the program's path.
 * Its folder must exist.
 */
export async function fakeProgram(file: string, body: string): Promise<string> {
  const program = programName(file);
  // Found next to the program, so a fake still runs after its folder is moved (an install swaps folders).
  const script = `${windows ? program.replace(/\.exe$/i, "") : program}.fake.cjs`;
  await writeFile(script, `${PREAMBLE}\n${body}\n`);
  if (windows) {
    const source = await launcher();
    await rm(program, { force: true });
    // A hard link costs nothing; the temp folder can be on another drive, so copy when it can't link.
    await link(source, program).catch(() => copyFile(source, program));
  } else {
    await writeFile(program, `#!/bin/sh\nexec '${process.execPath.replaceAll("'", `'\\''`)}' "$0.fake.cjs" "$@"\n`);
    await chmod(program, 0o755);
  }
  return program;
}
