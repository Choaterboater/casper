/**
 * The choices of Casper's own numbered questions that live in the app and in /mcp. Enter picks choice 1 on both
 * terminals, so choice 1 is always the one that does nothing risky (Stop, Leave it, Just this time, Keep writes
 * off); anything that builds, spends tokens, runs a check again, remembers or turns writes on takes a deliberate
 * 2 or 3. The AI's own ask tool never uses these. tests/safe-first-choice.test.ts keeps it that way.
 */
import { KIND_TEXT, RISKY_KINDS, type ChangeKind } from "../capabilities/kinds";
import { formatDuration } from "../verify/evidence";
import type { UnfinishedChoice } from "../verify/repair-loop";

export interface Choice { label: string; description?: string }

/** Asked after the plan on both terminals (on the rich one, after the plan editor). */
export const PLAN_QUESTION = "Build this plan?";

/** The choices of PLAN_QUESTION. */
export const PLAN_CHOICES = [
  { label: "Stop", description: "nothing is built" },
  { label: "Build", description: "the model builds these steps and tests these cases (uses tokens)" },
] as const satisfies readonly Choice[];

/** "<check> was already failing before this change. Fix it anyway?" */
export const ALREADY_FAILING_CHOICES = [
  { label: "Leave it", description: "keep the change as it is; the receipt says the check fails" },
  { label: "Fix it anyway", description: "ask the model to make it pass (uses tokens)" },
] as const satisfies readonly Choice[];

/** "The model failed again. What now?" Your big model, when one is set, comes last. */
export function modelFailedChoices(bigModel?: string): Choice[] {
  return [
    { label: "Stop", description: "keep the changes so far; /model picks another model" },
    { label: "Retry", description: "ask the same model to go on from where it stopped (uses tokens)" },
    ...(bigModel ? [{ label: "Retry with your big model", description: `go on from where it stopped on ${bigModel} (uses tokens)` }] : []),
  ];
}

/** "test timed out after 10m. Casper did not try to fix it. What now?" `had` is the limit the run just had (0 when
 * a check could not start), `longer` the limit "Allow more time" gives. */
export function unfinishedChoices(had: number, longer: number): Array<Choice & { choice: UnfinishedChoice | undefined }> {
  return [
    { label: "Stop", description: "keep the changes; the receipt says it did not finish", choice: undefined },
    { label: "Retry", description: "run it again with the same limit", choice: "retry" },
    { label: "Fix it anyway", description: had ? "ask the model to make it finish in time, for example a hanging or slow test (uses tokens)"
      : "ask the model to fix why it could not start (uses tokens)", choice: "repair" },
    ...(had && had < 3_600_000 ? [{ label: "Allow more time",
      description: `run it with ${formatDuration(longer)}; to keep a longer limit, set verification.timeoutMs in .casper/project.yaml`, choice: "more-time" as const }] : []),
  ];
}

/** At the repair limit: "test still fails after 3 repairs. What now?" The retry choice is built by the caller. */
export const REPAIR_LIMIT_STOP = { label: "Stop here", description: "keep the changes; the receipt says what fails" } as const satisfies Choice;

/** "Use <model> as your big model from now on?" */
export const REMEMBER_BIG_MODEL_CHOICES = [
  { label: "No", description: "only for this repair" },
  { label: "Yes", description: "save it as your big model (/model big clear forgets it)" },
] as const satisfies readonly Choice[];

/** /mcp connect: "Remember this server?" Typed answers: only "2" remembers. */
export const MCP_REMEMBER_CHOICES = ["Just this time", "Remember"] as const;
/** The MCP change box. 1 does nothing; a change takes a deliberate 2 or later. "Yes, for this session" covers later
 * changes on the same server that are not destructive, until the session ends or ctrl+o. */
export const APPROVE_CHOICES = ["No", "Yes, this once", "Yes, for this session"] as const;
/** When the tool's own preview can run first: "Preview first" runs it (nothing changes), then the box comes back. */
export const APPROVE_PREVIEW_CHOICES = ["No", "Preview first", "Yes, this once", "Yes, for this session"] as const;
/** A destructive change (reboot, delete, bounce...) asks every time: no session answer. */
export const APPROVE_ONCE_CHOICES = ["No", "Yes, this once"] as const;
export const APPROVE_ONCE_PREVIEW_CHOICES = ["No", "Preview first", "Yes, this once"] as const;

/** The change box's last choice: no more boxes on this server for the session, for any change (reboots, deletes, risky
 * kinds, an AI-set confirm). Only the person picks it; ctrl+o, writes off or a disconnect end it; it is never stored. */
export function approveAllLabel(product: string): string {
  return `Yes to everything on ${product} this session (no more asking, even reboots, deletes or an AI-set confirm)`;
}

/** A risky change kind (firmware, delete, admin) is off by default: 2 allows that kind on that server for this session. */
export function kindAllowChoices(kind: ChangeKind): string[] {
  return ["No", `Allow ${KIND_TEXT[kind].toLowerCase()} for this session`];
}

/** /mcp allow <name>: 1 keeps the defaults; then each risky kind, all of them, and everything (no asking) this session. */
export function allowKindsChoices(): string[] {
  return ["Keep the defaults", ...RISKY_KINDS.map((kind) => `Allow ${KIND_TEXT[kind].toLowerCase()}`), "Allow all change kinds",
    "Allow everything (no asking) this session"];
}
/** After picking kinds in /mcp allow: this session, or remembered for this server's exact definition. */
export const MCP_ALLOW_KEEP_CHOICES = ["This session", "Remember"] as const;

/** /lab import <file>: only "2" adds the hosts to your lab list. */
export const LAB_IMPORT_CHOICES = ["No", "Add them"] as const;

/** /mcp writes <name>: only "2" turns writes on. */
export const MCP_WRITES_CHOICES = ["Keep writes off", "Enable for this server"] as const;

/** "  1 Just this time\n  2 Remember\n" */
export function numberedLines(choices: readonly string[]): string {
  return choices.map((choice, index) => `  ${index + 1} ${choice}\n`).join("");
}

/** /undo or /redo when some files changed after the task: "notes.py changed after task 12." Cancel changes nothing. */
export function undoChangedChoices(verb: "Undo" | "Redo", others: number): Choice[] {
  return [
    { label: "Cancel", description: "nothing is changed" },
    { label: `${verb} the other ${others} ${others === 1 ? "file" : "files"}`, description: "the files you changed since stay as they are" },
  ];
}

/** "A shell command wants to reach api.mist.com." (the shell sandbox's host question). Enter keeps it blocked. */
export const HOST_CHOICES = [
  { label: "No", description: "the command can't reach it" },
  { label: "Allow for this session", description: "until Casper exits" },
  { label: "Always for this project", description: "kept in ~/.casper, never in the repo; /sandbox forget <host> undoes it" },
] as const satisfies readonly Choice[];

/** "The AI wants to write to ~/Library/Application Support/SomeApp." (a write outside the project, by the AI's
 * shell or its edit and write tools). Enter writes nothing; nothing is kept past the session. */
export function writeChoices(folder: string): Choice[] {
  return [
    { label: "No", description: "nothing is written" },
    { label: `Allow ${folder} for this session`, description: "until Casper exits; Casper keeps no undo copy there" },
  ];
}

/** "Reach 10.0.0.5 (build-server)?  ssh root@build-server uptime" before the AI's shell runs ssh, scp, sftp, rsync, nc, telnet or
 * socat to another machine, sandbox or not. Enter runs nothing. */
export const REACH_CHOICES = [
  { label: "No", description: "the command does not run" },
  { label: "Yes, this time", description: "this command only" },
  { label: "Yes, for this session", description: "commands to this host don't ask again until Casper exits" },
] as const satisfies readonly Choice[];

/** "Run this command?  npm test" when no sandbox can run (Windows, bubblewrap missing). Enter runs nothing. */
export const SHELL_COMMAND_CHOICES = [
  { label: "No", description: "the command does not run" },
  { label: "Yes, this once", description: "it runs with your permissions and network" },
  { label: "Yes, and don't ask again for this exact command here", description: "kept in ~/.casper for this project" },
] as const satisfies readonly Choice[];

/** "Next: the AI can read the 12 changed files for security problems …" after /security-review's tools. Enter spends nothing. */
export const AI_REVIEW_CHOICES = [
  { label: "Stop here", description: "no tokens are spent" },
  { label: "Run the AI review", description: "uses tokens; its findings are its opinion" },
] as const satisfies readonly Choice[];

/** A typed folder name that isn't there: "sample-tools isn't a folder in Documents." Enter stays and makes nothing. */
export function missingFolderChoices(folder: string, name: string, where = "here"): Choice[] {
  return [
    { label: `Stay in ${folder}`, description: "nothing is made" },
    { label: `Make ${name} ${where}`, description: "start a new project with that name" },
  ];
}

/** "The work is in ~/Documents/sample-tools." after a task whose files all sit in that project. Enter stays. */
export function workFolderChoices(here: string, there: string): Choice[] {
  return [
    { label: "Stay here", description: `keep working in ${here}` },
    { label: "Switch there", description: `your next request starts a new conversation in ${there}` },
  ];
}

/** "This task has used $5.02." when a task reaches the spend pause (spend.pauseAt, $5 by default). Enter stops;
 * the work so far is kept either way. `next` is where it asks again. */
export function spendChoices(next: string): Choice[] {
  return [
    { label: "Stop here", description: "the work so far is kept" },
    { label: "Keep going", description: `asks again at ${next}` },
  ];
}
