import type { ProjectCommand } from "../project/model";
import { CHECK_NAMES } from "./evidence";
import type { VerificationScope } from "./scope";

/** `auto`: Casper runs the selected checks after the model's edits. `offer`: the model may use
 * casper_check and the receipt suggests /verify. `off`: no managed checks during tasks. */
export type VerificationMode = "offer" | "auto" | "off";
export const VERIFICATION_MODES: readonly VerificationMode[] = ["offer", "auto", "off"];

export interface VerificationSettings {
  timeoutMs: number;
  /** Unset means "not configured": the surface picks its default. */
  mode?: VerificationMode;
  /** Unset means every configured check. */
  checks?: ProjectCommand[];
  /** `true` adds the requirements review round after the checks pass on a code change. Unset means
   * off (owner decision, Phase 4a): in pinned benchmarks the review added no first-time-right and cost
   * about 40% of Casper's wall time; the checks and the proof keep false "done" at zero. With it off, a
   * checklist the model's own answer ends with is still reported, and the change is still proven. */
  review?: boolean;
  /** Adds the independent acceptance check after the checks pass on a code change: tests written from
   * the request alone, by a separate low-effort model call, run once against the change. Signal only:
   * nothing is repaired or kept. `true`: a failure makes the receipt not verified. `"warn"`: a failure
   * never downgrades; the receipt names what the tests did not confirm. Unset or `false` means off
   * (experimental). */
  acceptance?: boolean | "warn";
}

/** Checks this fast run automatically in an unconfigured interactive session. */
export const FAST_CHECKS_MS = 60_000;

/** A flag wins for its run, then configuration. Unconfigured interactive sessions run checks
 * automatically once they are known to be fast (`measuredMs`, the cached duration of the
 * selected checks), otherwise offer them. Unconfigured one-shot prompts opt in with --verify. */
export function resolveVerificationMode(input: {
  flag?: VerificationMode;
  configured?: VerificationMode;
  interactive: boolean;
  measuredMs?: number;
}): VerificationMode {
  if (input.flag) return input.flag;
  if (input.configured) return input.configured;
  if (!input.interactive) return "off";
  return input.measuredMs !== undefined && input.measuredMs < FAST_CHECKS_MS ? "auto" : "offer";
}

/** `verification.checks`, or every check with a configured or detected command. */
export function selectedChecks(selected: readonly ProjectCommand[] | undefined, commands: Partial<Record<ProjectCommand, string>>): ProjectCommand[] {
  return selected ? [...selected] : CHECK_NAMES.filter((name) => commands[name]?.trim());
}

/** Why auto mode ran nothing after a model turn. */
export type AutoCheckSkip = "no-changes" | "no-checks" | "not-covered";

/** The checks auto mode runs after a model turn. `changedPaths` undefined means the change set
 * is unknown (a snapshot failed), so nothing can be skipped for being unaffected. A check with a
 * declared scope runs only when a changed path lies inside its inputs and outside its excludes. */
export function planAutoChecks(input: {
  selected?: readonly ProjectCommand[];
  commands: Partial<Record<ProjectCommand, string>>;
  scopes?: Partial<Record<ProjectCommand, VerificationScope>>;
  changedPaths?: readonly string[];
}): { run: ProjectCommand[]; skipped?: AutoCheckSkip } {
  if (input.changedPaths && !input.changedPaths.length) return { run: [], skipped: "no-changes" };
  const candidates = selectedChecks(input.selected, input.commands);
  if (!candidates.length) return { run: [], skipped: "no-checks" };
  const within = (file: string, entry: string) => entry === "." || file === entry || file.startsWith(`${entry}/`);
  const run = candidates.filter((name) => {
    const scope = input.scopes?.[name];
    if (!scope || !input.changedPaths) return true;
    return input.changedPaths.some((file) => scope.inputs.some((entry) => within(file, entry))
      && !scope.exclude?.some((entry) => within(file, entry)));
  });
  return run.length ? { run } : { run, skipped: "not-covered" };
}
