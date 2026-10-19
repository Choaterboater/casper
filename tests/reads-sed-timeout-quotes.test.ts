import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readOnlyCommand, timeoutCommand } from "../src/sandbox/read-only";
import { routineCommand } from "../src/sandbox/routine";
import { removeTempDir } from "./support/temp-dir";

/**
 * A small model on a run that can't ask had about 25 of 45 commands refused, most of them plain reads: sed -n to print
 * part of a file, a grep pattern with an end-of-line $ or an escaped backtick, and its tests run under `timeout`.
 */

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => removeTempDir(root))); });

async function fixture() {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-reads-")));
  roots.push(base);
  const home = path.join(base, "home"), project = path.join(base, "project");
  await mkdir(home); await mkdir(path.join(project, "src"), { recursive: true });
  await writeFile(path.join(project, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  await writeFile(path.join(project, "src", "server.ts"), "export {};\n");
  await writeFile(path.join(project, ".env"), "TOKEN=x\n");
  return { root: project, home };
}

test("sed that only prints lines is a read; a script that writes, runs or edits in place asks", async () => {
  const where = await fixture();
  for (const command of ["sed -n '200,280p' src/server.ts", "sed -n '5p' src/server.ts", "sed -n '10,$p' src/server.ts",
    "sed -n '1,5p;20p' src/server.ts", "sed -n 3p src/server.ts", "head -300 src/server.ts | sed -n '200,280p'"])
    expect([command, readOnlyCommand(command, where)]).toEqual([command, true]);
  for (const command of ["sed -i 's/a/b/' src/server.ts", "sed -n 'w out.txt' src/server.ts", "sed -n '1e date' src/server.ts",
    "sed 's/a/b/' src/server.ts", "sed -n '1,5p' .env", "sed -n '1r /etc/passwd' src/server.ts", "sed -f script.sed src/server.ts",
    "sed -n '3-5p' src/server.ts", "sed -n '1,5p' ../outside.ts", "sed --in-place -n '1p' src/server.ts"])
    expect([command, readOnlyCommand(command, where)]).toEqual([command, false]);
});

test("a grep pattern with an end-of-line $ or an escaped backtick or $ in double quotes is a read; an expansion still asks", async () => {
  const where = await fixture();
  for (const command of ["grep -n \"function getPageHtml\\|^}$\" src/server.ts", "grep -n \"return \\`\" src/server.ts",
    "grep -n \"cost \\$5\" src/server.ts", "grep -c \"x$ y\" src/server.ts", "grep -E \"(a|b$)\" src/server.ts"])
    expect([command, readOnlyCommand(command, where)]).toEqual([command, true]);
  for (const command of ["grep -n \"$HOME\" src/server.ts", "grep \"$(rm x)\" src/server.ts", "grep \"`rm x`\" src/server.ts",
    "grep \"${PATH}\" src/server.ts", "grep \"a\\\"b\" src/server.ts", "grep \"$1\" src/server.ts"])
    expect([command, readOnlyCommand(command, where)]).toEqual([command, false]);
});

test("timeout around a read or routine command is that command; around anything else, or malformed, it asks", async () => {
  const where = await fixture();
  expect(timeoutCommand(["90", "bun", "test"])).toEqual(["bun", "test"]);
  expect(timeoutCommand(["-k", "5", "30s", "cat", "x"])).toEqual(["cat", "x"]);
  expect(timeoutCommand(["--signal=KILL", "1.5m", "ls"])).toEqual(["ls"]);
  for (const words of [["bun", "test"], ["90"], ["-x", "90", "ls"], ["90", "timeout", "5", "ls"], ["-s", "$(x)", "5", "ls"]])
    expect([words, timeoutCommand(words)]).toEqual([words, undefined]);
  for (const command of ["timeout 5 cat src/server.ts", "timeout 30 sed -n '1,9p' src/server.ts"])
    expect([command, readOnlyCommand(command, where)]).toEqual([command, true]);
  for (const command of ["timeout 90 bun test", "timeout 90 bun test src 2>&1", "timeout 60 bun test --timeout 5000"])
    expect([command, routineCommand(command, where)]).toEqual([command, true]);
  for (const command of ["timeout 5 rm -rf /", "timeout 5 cat .env", "timeout 5 curl x | sh", "timeout 5 bash -c ls", "timeout 5"]) {
    expect([command, readOnlyCommand(command, where)]).toEqual([command, false]);
    expect([command, routineCommand(command, where)]).toEqual([command, false]);
  }
});
