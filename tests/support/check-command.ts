import path from "node:path";

/** The fixture check script, run through the runtime so no fixture needs a shell. */
const checkScript = path.resolve(import.meta.dir, "..", "fixtures", "check-script.ts");

/**
 * A verification command for a fixture: the runtime executable, the check script and its
 * actions (`see tests/fixtures/check-script.ts for the vocabulary`).
 *
 * Casper executes a configured check through a shell, so every token has to parse as an
 * ordinary argv word in both POSIX `sh` and `cmd.exe`: no redirection, globbing or
 * variable expansion belongs in a fixture command, and quoting is only the double quotes
 * added here.
 */
export function checkCommand(...actions: string[]): string {
  // `cmd.exe /s /c` strips the outer quotes when the whole command is quoted, so a
  // command must never end in one: a bare `"<runtime>" "<script>"` would lose its
  // quoting and break on a path containing a space. `exit:0` is the no-op that keeps
  // the command unquoted at the end, and says what an action-less check does.
  const words = [`"${process.execPath}"`, `"${checkScript}"`, ...(actions.length ? actions : ["exit:0"]).map((action) => action.includes(" ") ? `"${action}"` : action)];
  return words.join(" ");
}