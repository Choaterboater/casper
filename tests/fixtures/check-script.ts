import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";

/**
 * A fixture verification command without a shell.
 *
 * Casper runs a configured check as a shell command, so a fixture that says
 * `touch started` or `printf x >> test-runs` only runs on a host with a POSIX shell.
 * This script is invoked by absolute path through the runtime instead, which makes the
 * fixture's own work platform-neutral (`tests/support/check-command.ts` builds the
 * command); whether Casper's *check execution* works on a platform is still the
 * product's business, not this file's.
 *
 *   "<runtime>" "<this file>" touch:started "stderr:exact failure" exit:7
 *
 * Actions run in order; the first failed requirement ends the run with `fail:<code>`
 * (default 1) and a one-line reason on stderr:
 *
 *   append:<file>[=<text>]        append text (default "x"), creating the file
 *   write:<file>=<text>           write text, creating or replacing the file
 *   mkdir:<dir>                   create a directory tree
 *   touch:<file>                  create an empty file if it is absent
 *   remove:<file>                 delete a file if it is present
 *   require:<file>                fail if the file is absent
 *   forbid:<file>                 fail if the file is present
 *   require-line:<file>=<text>    fail unless the file contains that exact line
 *   stdout:<text>                 write text to stdout
 *   stderr:<text>                 write text to stderr
 *   cwd                           write the current working directory to stdout
 *   pad:<n>                       write n "x" characters to stdout
 *   sleep:<ms>                    wait
 *   wait:<file>                   wait until the file exists (the check timeout still wins)
 *   fail:<code>                   exit code for later failed requirements (put it first)
 *   on-failure:<action>           run that action just before a later failed requirement ends the run
 *   exit:<code>                   stop here with this exit code
 */

function halves(value: string): [string, string | undefined] {
  const at = value.indexOf("=");
  return at === -1 ? [value, undefined] : [value.slice(0, at), value.slice(at + 1)];
}

const exists = (file: string): Promise<boolean> => stat(file).then(() => true, () => false);

async function run(tokens: string[]): Promise<number> {
  let failCode = 1;
  let onFailure: string | undefined;

  /** A failed requirement: its side effect first, then the reason and the exit code. */
  async function failed(reason: string): Promise<number> {
    if (onFailure) await apply(onFailure);
    return report(reason, failCode);
  }

  async function apply(token: string): Promise<number | undefined> {
    const at = token.indexOf(":");
    const verb = at === -1 ? token : token.slice(0, at);
    const rest = at === -1 ? "" : token.slice(at + 1);
    switch (verb) {
      case "append": { const [file, text] = halves(rest); await appendFile(file, text ?? "x"); break; }
      case "write": { const [file, text] = halves(rest); await writeFile(file, text ?? ""); break; }
      case "mkdir": await mkdir(rest, { recursive: true }); break;
      case "touch": if (!await exists(rest)) await writeFile(rest, ""); break;
      case "remove": await rm(rest, { force: true }); break;
      case "require": if (!await exists(rest)) return failed(`missing ${rest}`); break;
      case "forbid": if (await exists(rest)) return failed(`unexpected ${rest}`); break;
      case "require-line": {
        const [file, text] = halves(rest);
        const lines = await readFile(file, "utf8").then((body) => body.split("\n"), (): string[] => []);
        if (!lines.includes(text ?? "")) return failed(`${file} does not contain ${JSON.stringify(text)}`);
        break;
      }
      case "stdout": process.stdout.write(rest); break;
      case "stderr": process.stderr.write(rest); break;
      case "cwd": process.stdout.write(process.cwd()); break;
      case "pad": process.stdout.write("x".repeat(Number(rest))); break;
      case "sleep": await Bun.sleep(Number(rest)); break;
      case "wait": for (let attempt = 0; attempt < 10_000 && !await exists(rest); attempt++) await Bun.sleep(10); break;
      case "fail": failCode = Number(rest); break;
      case "on-failure": onFailure = rest; break;
      case "exit": return Number(rest);
      default: return report(`unknown action ${token}`, 2);
    }
    return undefined;
  }

  for (const token of tokens) {
    const stop = await apply(token);
    if (stop !== undefined) return stop;
  }
  return 0;
}

function report(reason: string, code: number): number {
  process.stderr.write(`${reason}\n`);
  return code;
}

process.exitCode = await run(process.argv.slice(2));