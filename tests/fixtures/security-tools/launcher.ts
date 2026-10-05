// Windows can't start a "#!/bin/sh" script, so there a test's fake program is this file built into an .exe
// (see fakeProgram in setup.ts). Each copy reads "<its own name>.launch.json" next to it and runs the command
// in it with its own arguments added, the same stdin, stdout, stderr, folder and environment, and exits the same way.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const { argv } = JSON.parse(readFileSync(process.execPath.replace(/\.exe$/i, ".launch.json"), "utf8")) as { argv: string[] };
const result = spawnSync(argv[0]!, [...argv.slice(1), ...process.argv.slice(2)], { stdio: "inherit", windowsHide: true });
process.exit(result.status ?? 1);
