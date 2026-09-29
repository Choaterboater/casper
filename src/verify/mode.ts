import type { ProjectCommand } from "../project/model";
import { CHECK_NAMES, type CheckName } from "./evidence";
import { autoNamedChecks, manualNamedChecks, type NamedCheckSpec } from "./named";
import type { VerificationScope } from "./scope";

/** `auto`: Casper runs the selected checks after the model's edits. `offer`: the model may use
 * casper_check and the receipt suggests /verify. `off`: no managed checks during tasks. */
export type VerificationMode = "offer" | "auto" | "off";
export const VERIFICATION_MODES: readonly VerificationMode[] = ["offer", "auto", "off"];

export interface VerificationSettings {
  timeoutMs: number;
  /** Unset means "not configured": the surface picks its default. */
  mode?: VerificationMode;
  /** Unset means every configured check, and every named check that runs after each change. */
  checks?: CheckName[];
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
  /** Before the model's turn, one separate low-effort model call lists the concrete cases the request
   * states; Casper shows them (editable in an interactive session) and asks for one test per case.
   * Unset: on for interactive implement/fix/test requests, off otherwise. `true` also covers one-shot
   * runs and every request; `false` turns it off. */
  checklist?: boolean;
}

/** Checks known to take at least this long are offered, not run after every change, in an interactive session. */
export const FAST_CHECKS_MS = 60_000;

/** A flag wins for its run, then configuration. Otherwise Casper checks its own work: `auto`, so the
 * first change runs the checks with no command from the user (and times them). An interactive session
 * offers them instead (`/verify`) only once they are known to be slow (`measuredMs`, the cached duration
 * of the selected checks, at least 60 s). One-shot cannot ask, so it stays `auto`; `--no-verify` or
 * `verification.mode` turn it off. */
export function resolveVerificationMode(input: {
  flag?: VerificationMode;
  configured?: VerificationMode;
  interactive: boolean;
  measuredMs?: number;
}): VerificationMode {
  if (input.flag) return input.flag;
  if (input.configured) return input.configured;
  return input.interactive && input.measuredMs !== undefined && input.measuredMs >= FAST_CHECKS_MS ? "offer" : "auto";
}

/** What Casper checks after a change in this session: the mode and the selected checks. `slow`: the
 * mode is `offer` only because the checks were timed at a minute or more (not a flag or configuration). */
export interface ChecksPlan {
  mode: VerificationMode; checks: CheckName[]; slow?: boolean;
  /** Named checks that run only with /verify <name> (set to "ask", and reports). */
  manual?: string[];
}

/** The banner's and /status's plain line for a ChecksPlan. */
export function describeChecksPlan(plan: ChecksPlan): string {
  if (plan.mode === "off") return "off for this session (--no-verify or verification.mode: off)";
  const manual = plan.manual?.length ? ` · with /verify <name> only: ${plan.manual.join(", ")}` : "";
  if (!plan.checks.length) return `none found; add verify.test to .casper/project.yaml${manual}`;
  return `${plan.checks.join(", ")} — ${plan.mode === "auto" ? "run after each change"
    : plan.slow ? "offered with /verify (they take a minute or more)" : "offered with /verify (verification.mode: offer)"}${manual}`;
}

/** `verification.checks`, or every check with a configured or detected command and every named check that
 * runs after each change. */
export function selectedChecks(selected: readonly CheckName[] | undefined, commands: Partial<Record<ProjectCommand, string>>,
  named?: Record<string, NamedCheckSpec>): CheckName[] {
  return selected ? [...selected] : [...CHECK_NAMES.filter((name) => commands[name]?.trim()), ...autoNamedChecks(named)];
}

/** The named checks a plan lists as /verify-only: never ones already selected, never lab checks. */
export function manualChecks(selected: readonly CheckName[], named?: Record<string, NamedCheckSpec>): string[] {
  return manualNamedChecks(named).filter((name) => !selected.includes(name));
}

/** Why auto mode ran nothing after a model turn. */
export type AutoCheckSkip = "no-changes" | "no-checks" | "not-covered";

/** The checks auto mode runs after a model turn. `changedPaths` undefined means the change set
 * is unknown (a snapshot failed), so nothing can be skipped for being unaffected. A check with a
 * declared scope runs only when a changed path lies inside its inputs and outside its excludes. */
export function planAutoChecks(input: {
  selected?: readonly CheckName[];
  commands: Partial<Record<ProjectCommand, string>>;
  scopes?: Partial<Record<ProjectCommand, VerificationScope>>;
  named?: Record<string, NamedCheckSpec>;
  changedPaths?: readonly string[];
}): { run: CheckName[]; skipped?: AutoCheckSkip } {
  if (input.changedPaths && !input.changedPaths.length) return { run: [], skipped: "no-changes" };
  const candidates = selectedChecks(input.selected, input.commands, input.named);
  if (!candidates.length) return { run: [], skipped: "no-checks" };
  const within = (file: string, entry: string) => entry === "." || file === entry || file.startsWith(`${entry}/`);
  const run = candidates.filter((name) => {
    const scope = input.scopes?.[name as ProjectCommand];
    if (!scope || !input.changedPaths) return true;
    return input.changedPaths.some((file) => scope.inputs.some((entry) => within(file, entry))
      && !scope.exclude?.some((entry) => within(file, entry)));
  });
  return run.length ? { run } : { run, skipped: "not-covered" };
}
