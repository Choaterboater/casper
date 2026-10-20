import type { VerificationResult } from "./evidence";

/**
 * The program a check could not start because this computer doesn't have it: `go` for `go test ./...` when the shell
 * says `go: command not found` (or cmd.exe's "'go' is not recognized"). Only the check's own first program counts:
 * `jest: not found` under `npm test` is usually dependencies not installed yet, which the model can fix. On a NAS whose
 * Go app runs in Docker, Casper asked "Fix it anyway?" again and again; no change to the code installs Go.
 */
export function missingProgram(result: Pick<VerificationResult, "ended" | "command" | "stderr">): string | undefined {
  if (result.ended !== "no_start") return undefined;
  const program = firstProgram(result.command ?? "");
  if (!program) return undefined;
  const name = program.replace(/\.(?:exe|cmd|bat)$/i, "");
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const unix = new RegExp(`(?:^|[\\s:/])${escaped}: (?:command )?not found\\b`, "im");
  const windows = new RegExp(`^\\s*'${escaped}(?:\\.(?:exe|cmd|bat))?' is not recognized as an internal or external command`, "im");
  return unix.test(result.stderr) || windows.test(result.stderr) ? name : undefined;
}

/** The first word of a check's command that is a program: past `VAR=value` settings, without a path. */
function firstProgram(command: string): string | undefined {
  const words = command.trim().split(/\s+/);
  const word = words.find((item) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(item));
  if (!word || !/^[\w./\\:+-]+$/.test(word)) return undefined;
  return word.split(/[\\/]/).pop() || undefined;
}

/** "go isn't installed on this computer": said instead of offering a repair or a retry, which can't help. */
export const missingProgramLine = (program: string) => `${program} isn't installed on this computer`;
