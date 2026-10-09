/**
 * The choices of Casper's own numbered questions that live in the app and in /mcp. Enter picks choice 1 on both
 * terminals, so choice 1 is always the one that does nothing risky (Stop, Leave it, No, Keep writes
 * off); anything that builds, spends tokens, runs a check again, remembers or turns writes on takes a deliberate
 * 2 or 3. The AI's own ask tool never uses these. tests/safe-first-choice.test.ts keeps it that way.
 *
 * Every approval box says yes in the same words, with the same numbers: 1 No · 2 Yes, this once · 3 Yes, for this
 * session · 4 Yes, always for this project. A box offers only the ones that make sense, first and in that order; what
 * the yes is about goes in the question. tests/yes-words.test.ts keeps it that way.
 */
import { KIND_TEXT, RISKY_KINDS, type ChangeKind } from "../capabilities/kinds";
import { formatDuration } from "../verify/evidence";
import type { UnfinishedChoice } from "../verify/repair-loop";

export interface Choice { label: string; description?: string }

export const NO = "No";
export const YES_ONCE = "Yes, this once";
export const YES_SESSION = "Yes, for this session";
export const YES_ALWAYS = "Yes, always for this project";
/** The yes-words of every approval box, in order: choice 1, 2, 3 and 4 wherever they appear. */
export const YES_WORDS = [NO, YES_ONCE, YES_SESSION, YES_ALWAYS] as const;

/** Asked after the plan on both terminals (on the rich one, after the plan editor). */
export const PLAN_QUESTION = "Build this plan?";

/** The choices of PLAN_QUESTION. */
export const PLAN_CHOICES = [
  { label: "Stop", description: "nothing is built" },
  { label: "Build", description: "the model builds these steps and tests these cases (uses tokens)" },
] as const satisfies readonly Choice[];

/** The same, on a rich terminal: a third choice opens the plan's lines to change. Stop stays first and Build second. */
export const PLAN_CHOICES_EDIT = [
  ...PLAN_CHOICES,
  { label: "Edit the plan", description: "change the steps and cases first, then choose again" },
] as const satisfies readonly Choice[];

/** "<model> can't see pictures, and this request has one." Both send the request: 1 on your model without the
 * pictures, 2 on one that sees them, for this request only. */
export function pictureChoices(model: string, count: number): Choice[] {
  const them = count === 1 ? "it" : "them";
  return [
    { label: `Send without ${them}`, description: "on your model; the AI reads only the words" },
    { label: `Switch to ${model} for this request`, description: "then back to your model (it may cost more)" },
  ];
}

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
export function unfinishedChoices(had: number, longer: number): Array<Choice & { choice: UnfinishedChoice | "more-time-saved" | undefined }> {
  return [
    { label: "Stop", description: "keep the changes; the receipt says it did not finish", choice: undefined },
    { label: "Retry", description: "run it again with the same limit", choice: "retry" },
    { label: "Fix it anyway", description: had ? "ask the model to make it finish in time, for example a hanging or slow test (uses tokens)"
      : "ask the model to fix why it could not start (uses tokens)", choice: "repair" },
    ...(had && had < 3_600_000 ? [{ label: "Allow more time", description: `run it with ${formatDuration(longer)}, this time only`, choice: "more-time" as const },
      { label: "Allow more time from now on", description: `run it with ${formatDuration(longer)}, and give every check in this project that long (saved for you)`,
        choice: "more-time-saved" as const }] : []),
  ];
}

/** At the repair limit: "test still fails after 3 repairs. What now?" The retry choice is built by the caller. */
export const REPAIR_LIMIT_STOP = { label: "Stop here", description: "keep the changes; the receipt says what fails" } as const satisfies Choice;

/** "Use <model> as your big model from now on?" */
export const REMEMBER_BIG_MODEL_CHOICES = [
  { label: "No", description: "only for this repair" },
  { label: "Yes", description: "save it as your big model (/model big clear forgets it)" },
] as const satisfies readonly Choice[];

/** /mcp connect: "Remember lab?" Only "Yes" remembers. */
export const MCP_REMEMBER_CHOICES = [NO, "Yes"] as const;
/** The MCP change box. 1 does nothing; a change takes a deliberate 2 or later. "Yes, for this session" covers later
 * changes on the same server that are not destructive, until the session ends or ctrl+o. */
export const APPROVE_CHOICES = [NO, YES_ONCE, YES_SESSION] as const;
/** When the tool's own preview can run first: "Preview first" runs it (nothing changes), then the box comes back. It
 * comes after the yes-words, so 2 and 3 mean the same in every change box. */
export const APPROVE_PREVIEW_CHOICES = [NO, YES_ONCE, YES_SESSION, "Preview first"] as const;
/** A destructive change (reboot, delete, bounce...) asks every time: no session answer. */
export const APPROVE_ONCE_CHOICES = [NO, YES_ONCE] as const;
export const APPROVE_ONCE_PREVIEW_CHOICES = [NO, YES_ONCE, "Preview first"] as const;

/** A plain Junos show command's box, third: the same switch as /mcp junos-show <server> on, for this session.
 * Changes and other commands on that server still ask. */
export function junosShowLabel(server: string): string {
  return `Yes, show commands on ${server} for this session`;
}

/** The change box's last choice: no more boxes on this server for the session, for any change (reboots, deletes, risky
 * kinds, an AI-set confirm). Only the person picks it; ctrl+o, writes off or a disconnect end it; it is never stored. */
export function approveAllLabel(product: string): string {
  return `Yes to everything on ${product} this session (no more asking, even reboots, deletes or an AI-set confirm)`;
}

/** A risky change kind (firmware, delete, admin) is off by default ("Allow firmware changes on Mist?"): 2 allows it
 * for this call, 3 for this session on that server. The change box still asks about the call itself. */
export function kindAllowChoices(_kind: ChangeKind): string[] {
  return [NO, YES_ONCE, YES_SESSION];
}

/** /mcp allow <name>: 1 keeps the defaults; then each risky kind, all of them, and everything (no asking) this session. */
export function allowKindsChoices(): string[] {
  return ["Keep the defaults", ...RISKY_KINDS.map((kind) => `Allow ${KIND_TEXT[kind].toLowerCase()}`), "Allow all change kinds",
    "Allow everything (no asking) this session"];
}
/** After picking kinds in /mcp allow: this session, or remembered for this server's exact definition. */
export const MCP_ALLOW_KEEP_CHOICES = ["This session", "Remember"] as const;

/** /references add <name>: only "2" runs the shown git commands. */
export const REFERENCE_ADD_CHOICES = ["No", "Download"] as const;

/** /mcp docs: "Add a docs-only copy (no passwords, no device access)?" Only "2" adds it. */
export const DOCS_COPY_CHOICES = [NO, "Add it"] as const;

/** /skills trust <id>: "Trust deploy as shown?" after the skill and its fingerprint. Only "2" trusts it. */
export const SKILL_TRUST_CHOICES = [NO, "Trust it"] as const;

/** /lab import <file>: only "2" adds the hosts to your lab list. */
export const LAB_IMPORT_CHOICES = ["No", "Add them"] as const;

/** "Casper can set up its network server …": only "2" installs it. Asked once on the first network question, or by
 * /mcp setup network; "Not now" is kept, so it isn't asked again until you type that. */
export const NETWORK_SETUP_CHOICES = ["Not now", "Set it up"] as const;
/** The same question when uv isn't installed: only "2" runs uv's official installer (shown first), then sets it up. */
export const NETWORK_SETUP_UV_CHOICES = ["Not now", "Install uv, then set it up"] as const;
/** "Casper's network server has an update (0.1.0 → 0.2.0 …)": only "2" downloads it; "Not now" keeps the old one. */
export const NETWORK_UPDATE_CHOICES = ["Not now", "Update it"] as const;

/** /mcp setup ssh "Which ssh host?": Not now, the hosts from ~/.ssh/config, then Type a host (Casper says the line to type). */
export function sshHostChoices(hosts: readonly string[]): string[] {
  return ["Not now", ...hosts, "Type a host"];
}
/** /mcp setup ssh "Name it?": Not now, the default name (the host), then Type a name. Only "2" writes the entry. */
export function sshNameChoices(name: string): string[] {
  return ["Not now", name, "Type a name"];
}

/** "Mist isn't set up yet. Casper will ask for a Mist API token …": only "2" asks for the login. */
export const ADD_LOGIN_CHOICES = ["Not now", "Add a login"] as const;
/** "The ClearPass login didn't work (… it may have expired). Replace it?": only "2" asks for the new login. */
export const REPLACE_LOGIN_CHOICES = ["Not now", "Replace the login"] as const;
/** /mcp login <product> forget: only "2" forgets it. */
export function forgetLoginChoices(product: string): string[] {
  return [`Keep the ${product} login`, `Forget the ${product} login`];
}

/** /mcp writes <name>: only "2" turns writes on. */
export const MCP_WRITES_CHOICES = ["Keep writes off", "Enable for this server"] as const;

/** "  1 No\n  2 Download\n": a numbered question's lines (the network setup, logins and /references add); the app
 * asks them in the same numbered box as every approval. */
/** casper doctor: a newer Casper is out. Only "2" runs casper update. */
export const DOCTOR_UPDATE_CHOICES = ["Not now", "Update now"] as const;
/** casper doctor: security tools this project uses are missing. Only "2" downloads them (hash-checked). */
export const DOCTOR_INSTALL_CHOICES = ["Not now", "Install them"] as const;

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
  { label: NO, description: "the command can't reach it" },
  { label: YES_ONCE, description: "this connection only" },
  { label: YES_SESSION, description: "until Casper exits" },
  { label: YES_ALWAYS, description: "kept in ~/.casper, never in the repo; /sandbox forget <host> undoes it" },
] as const satisfies readonly Choice[];

/** /permissions all: the person's own box. Keep asking is first, so Enter changes nothing. */
export const PERMISSIONS_ALL_QUESTION = "Stop asking until you quit?";
export const PERMISSIONS_ALL_CHOICES = [
  { label: "Keep asking", description: "nothing changes" },
  { label: "Stop asking until I quit", description: "shell commands, hosts, writes outside the project and other machines are answered Yes for this session; protected places, secrets, device writes and the spend pause stay as they are" },
] as const satisfies readonly Choice[];

/** "test failed because the sandbox blocked something." Enter keeps the sandbox. */
export const checksOutsideQuestion = (names: string[]) =>
  `${names.join(", ")} failed because Casper's sandbox blocked something, not because of a bug in your code. Run this project's checks outside the sandbox?`;
export const CHECKS_OUTSIDE_CHOICES = [
  { label: NO, description: "the check stays could-not-check; run it yourself with !<command>" },
  { label: YES_ONCE, description: "run the blocked checks again now, outside the sandbox" },
  { label: YES_SESSION, description: "this project's checks run outside the sandbox until Casper exits" },
  { label: YES_ALWAYS, description: "kept in ~/.casper, never in the repo; /allowed forget undoes it" },
] as const satisfies readonly Choice[];

/** "The AI wants to write to ~/Library/Application Support/SomeApp. Allow it?" (a write outside the project, by the
 * AI's shell or its edit and write tools). Enter writes nothing; nothing is kept past the session. */
export function writeChoices(_folder: string, always = true): Choice[] {
  return [
    { label: NO, description: "nothing is written" },
    { label: YES_ONCE, description: "this write only (for a shell command, the next command); Casper keeps no undo copy there" },
    { label: YES_SESSION, description: "until Casper exits; Casper keeps no undo copy there" },
    // Only where a whole folder is offered (not one file), and never for a protected place: those are not asked about at all.
    ...(always ? [{ label: YES_ALWAYS, description: "this folder and below, for this project; kept in ~/.casper, never in the repo; /permissions forget <folder> undoes it" }] : []),
  ];
}

/** "Reach 10.0.0.5 (build-server)?  ssh root@build-server uptime" before the AI's shell runs ssh, scp, sftp, rsync, nc, telnet or
 * socat to another machine, sandbox or not. Enter runs nothing. */
export const REACH_CHOICES = [
  { label: NO, description: "the command does not run" },
  { label: YES_ONCE, description: "this command only" },
  { label: YES_SESSION, description: "commands to this host don't ask again until Casper exits" },
  { label: YES_ALWAYS, description: "kept in ~/.casper, never in the repo; /sandbox forget <host> undoes it" },
] as const satisfies readonly Choice[];

/** "Run outside the sandbox with your GitHub login?  git push -u origin main": a plain git push, pull, fetch, clone or
 * ls-remote, or gh pr, issue, run, repo, api (GET) or auth status, that the sandbox would run without your login. Enter
 * runs nothing. 3 and 4 cover that kind of command (`git push`); a command that types its own address gets 1 and 2 only. */
export function githubLoginChoices(action: string, remember = true): Choice[] {
  return [
    { label: NO, description: "the command does not run" },
    { label: YES_ONCE, description: "this command only; the AI reads its output, never your login" },
    ...(remember ? [
      { label: YES_SESSION, description: `${action} commands don't ask again until Casper exits` },
      { label: YES_ALWAYS, description: `${action} commands; kept in ~/.casper, never in the repo; /allowed forget undoes it` },
    ] : []),
  ];
}

/** "Run this command?  npm test --watch" when no sandbox can run (Windows, bubblewrap missing). Enter runs nothing.
 * 3 and 4 cover commands starting with the prefix (`npm test`), or this exact command when it has none. */
export function shellCommandChoices(prefix?: string): Choice[] {
  const covers = prefix ? `commands starting with ${prefix}` : "this exact command";
  return [
    { label: NO, description: "the command does not run" },
    { label: YES_ONCE, description: "it runs with your permissions and network" },
    { label: YES_SESSION, description: `${covers} don't ask again until Casper exits` },
    { label: YES_ALWAYS, description: `${covers}; kept in ~/.casper, never in the repo` },
  ];
}
export const SHELL_COMMAND_CHOICES = shellCommandChoices();

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
