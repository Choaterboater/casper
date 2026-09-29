import type { ProjectCommand } from "../project/model";
import {
  autoNetworkCheckNames, modelNetworkCheckNames, parseNetworkChecks, RESERVED_CHECK_NAMES, type NetworkCheckSpec,
} from "../network/spec";

/**
 * Named checks: `verify.checks.<name>` in .casper/project.yaml, next to the four built-in checks
 * (typecheck, lint, test, build). A named check is either a command the project gives (`run`, run
 * the same way as verify.test) or a ready-made check whose argument list Casper builds itself and
 * runs without a shell (`preset`).
 *
 * Kinds: an ordinary check passes or fails. A report (a diff) is shown for reading and never makes a
 * run pass or fail. A lab check reaches the user's own lab devices: it never runs on its own, the AI
 * can never start it, and in this version Casper does not run it at all (it needs the shell sandbox).
 */

/** A check's name: a built-in check, or a name the project gave under verify.checks. */
export type CheckName = ProjectCommand | (string & {});

export type NamedCheckSpec = NetworkCheckSpec;

/** Parse `verify.checks` (project layer only). */
export const parseNamedChecks = parseNetworkChecks;

export function isBuiltinCheck(name: string): name is ProjectCommand {
  return (RESERVED_CHECK_NAMES as readonly string[]).includes(name);
}

/** Named checks that run after each change with the built-in ones: ordinary checks not set to "ask". */
export function autoNamedChecks(named: Record<string, NamedCheckSpec> | undefined): string[] {
  return named ? autoNetworkCheckNames(named) : [];
}

/** Named checks the AI may run through casper_check and /verify runs with no names: never lab checks. */
export function modelNamedChecks(named: Record<string, NamedCheckSpec> | undefined): string[] {
  return named ? modelNetworkCheckNames(named) : [];
}

/** Named checks that only run when the user starts them: ordinary checks set to "ask", and reports. */
export function manualNamedChecks(named: Record<string, NamedCheckSpec> | undefined): string[] {
  if (!named) return [];
  const auto = new Set(autoNamedChecks(named));
  return modelNamedChecks(named).filter((name) => !auto.has(name));
}

export function labNamedChecks(named: Record<string, NamedCheckSpec> | undefined): string[] {
  return named ? Object.entries(named).filter(([, spec]) => spec.kind === "lab").map(([name]) => name) : [];
}

/** What Casper says for a lab check in this version. */
export const LAB_NOT_YET = "lab checks are not run yet: Casper will run them on your own lab only once its shell sandbox ships";

/** Each check's command line by name, for timing: built-in commands and named `run` commands. */
export function checkCommands(model: { commands: Partial<Record<ProjectCommand, string>>; namedChecks?: Record<string, NamedCheckSpec> }): Record<string, string> {
  const commands: Record<string, string> = { ...model.commands } as Record<string, string>;
  for (const [name, spec] of Object.entries(model.namedChecks ?? {})) if (spec.run) commands[name] = spec.run;
  return commands;
}
