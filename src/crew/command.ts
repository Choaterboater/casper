/**
 * /crew: a builder does a job in its own copy of the project (a Git worktree) while your folder stays as it is.
 * Only the person starts one (the AI never does: a crew spends tokens, and Casper spends none by default). When the
 * builder ends, one numbered question: 1 keep the copy to look at first (Enter) · 2 apply it to your folder,
 * uncommitted · 3 throw it away (the files are kept in Casper's recovery folder). Bare /crew lists copies still here.
 *
 * This is phase 1 of crews (docs/CREWS.md): one builder per crew. Splitting a job into parts, a reviewer per part,
 * merging, and /undo over a landed crew come next.
 */
import { randomBytes } from "node:crypto";
import type { BuilderRunOptions, SubagentResult } from "../agents/manager";
import type { Choice } from "../app/safe-choices";
import type { RuntimeShell } from "../runtime/types";
import { formatCost } from "../task/spend";
import { redactPreview, terminalText } from "../tui/format";
import { GitWorktreeManager, type WorktreePatch, type WorktreeRelation } from "../workspace/worktree";
import { linkDependencies, unlinkDependencies } from "./copies";

export interface CrewHost {
  /** The project folder (the main one; a crew does not start from an experiment's copy). */
  root: string;
  homeDir: string;
  write(text: string): void;
  /** Someone can answer a numbered question now. */
  canAsk(): boolean;
  pick(question: string, options: Choice[], signal?: AbortSignal): Promise<string | undefined>;
  signal?: AbortSignal;
  /** The project's rules and facts, as a helper gets them. */
  projectContext: string;
  runBuilder(options: BuilderRunOptions): Promise<SubagentResult>;
  /** The builder's shell around its copy; `note` gets what was not run because it needed your OK. */
  shell(copy: string, note: (line: string) => void): (RuntimeShell & { close(): Promise<void> }) | undefined;
}

export const CREW_USAGE = "Usage: /crew <job> · /crew (copies still here) · /crew apply <n> · /crew drop <n>";
export const CREW_QUESTION = "What should happen to the crew's work?";
export const KEEP_COPY = "Keep the copy";
export const APPLY_COPY = "Apply to my folder";
export const DROP_COPY = "Throw it away";

/** Enter keeps the copy: nothing changes in your folder until you pick 2. */
export function crewChoices(copy: string): Choice[] {
  return [
    { label: KEEP_COPY, description: `look first: ${copy}; /crew applies it later` },
    { label: APPLY_COPY, description: "uncommitted; your own changes stay" },
    { label: DROP_COPY, description: "the files are kept in Casper's recovery folder" },
  ];
}

export const LEAVE_COPIES = "Leave them";
/** Bare /crew: "1 Leave them · 2 Apply 1 · 3 Throw away 1 · ...". */
export function copiesChoices(count: number): Choice[] {
  return [
    { label: LEAVE_COPIES, description: "nothing changes" },
    ...Array.from({ length: count }, (_, index) => [
      { label: `Apply ${index + 1}`, description: "to your folder, uncommitted" },
      { label: `Throw away ${index + 1}`, description: "kept in Casper's recovery folder" },
    ]).flat(),
  ];
}

const say = (host: CrewHost, line: string) => host.write(`[crew] ${line}\n`);
const shown = (text: string) => redactPreview(text).replace(/\s+/g, " ").trim();

function costText(result: SubagentResult): string {
  if (!result.usage) return "cost not reported";
  return `${result.usage.tokens.toLocaleString("en-US")} tokens${result.usage.estimatedCost > 0 ? ` · about ${formatCost(result.usage.estimatedCost)}` : ""}`;
}

async function readWork(manager: GitWorktreeManager, copy: WorktreeRelation): Promise<WorktreePatch> {
  await unlinkDependencies(copy.path);
  return manager.capturePatch(copy);
}

async function apply(host: CrewHost, manager: GitWorktreeManager, copy: WorktreeRelation, work: WorktreePatch): Promise<void> {
  try { await manager.applyCrew(copy, work); }
  catch (error) {
    say(host, `Not applied: ${shown(error instanceof Error ? error.message : String(error))}. The work stays in the copy: ${terminalText(copy.path)}`);
    return;
  }
  say(host, `Applied to your folder, uncommitted (${work.files.length} file${work.files.length === 1 ? "" : "s"}). git diff shows it.`);
  await drop(host, manager, copy, work, false);
}

async function drop(host: CrewHost, manager: GitWorktreeManager, copy: WorktreeRelation, work: WorktreePatch, said = true): Promise<void> {
  try {
    const kept = await manager.remove(copy, work);
    if (said) say(host, `Thrown away${kept ? `; the files are kept at ${terminalText(kept)}` : ""}.`);
  } catch (error) {
    say(host, `The copy could not be removed (${shown(error instanceof Error ? error.message : String(error))}); it stays at ${terminalText(copy.path)}`);
  }
}

/** /crew [job | apply <n> | drop <n>]. */
export async function runCrewCommand(host: CrewHost, argument: string): Promise<void> {
  const manager = await GitWorktreeManager.open(host.root, host.homeDir);
  if (!manager) {
    say(host, "A crew needs a Git repository: each builder works in its own copy. Ask for the job as usual and Casper does it as one task.");
    return;
  }
  const typed = /^(apply|drop)\s+(\d+)$/i.exec(argument.trim());
  if (!argument.trim() || typed) return copies(host, manager, typed ? { action: typed[1]!.toLowerCase() as "apply" | "drop", number: Number(typed[2]) } : undefined);
  await startCrew(host, manager, argument.trim());
}

async function copies(host: CrewHost, manager: GitWorktreeManager, typed?: { action: "apply" | "drop"; number: number }): Promise<void> {
  const found = await manager.crewCopies();
  if (!found.length) {
    say(host, "No crew copies here. /crew <job> starts one: a builder does the job in its own copy of the project.");
    return;
  }
  const work: Array<WorktreePatch | string> = [];
  for (const copy of found) work.push(await readWork(manager, copy).catch((error: unknown) => shown(error instanceof Error ? error.message : String(error))));
  if (!typed) {
    host.write(`[crew] Crew copies still here:\n${found.map((copy, index) => {
      const entry = work[index]!;
      const what = typeof entry === "string" ? `changes can't be read: ${entry}` : `${entry.files.length} file${entry.files.length === 1 ? "" : "s"} changed`;
      return `  ${index + 1} ${copy.branch} · ${what} · ${terminalText(copy.path)}`;
    }).join("\n")}\n`);
  }
  let picked: string | undefined;
  if (typed) picked = `${typed.action === "apply" ? "Apply" : "Throw away"} ${typed.number}`;
  else if (!host.canAsk()) { say(host, "To use one: /crew apply <n> or /crew drop <n>."); return; }
  else picked = await host.pick("Apply or throw one away?", copiesChoices(found.length), host.signal);
  const match = /^(Apply|Throw away) (\d+)$/.exec(picked ?? "");
  const index = match ? Number(match[2]) - 1 : -1;
  if (!match || index < 0 || index >= found.length) {
    say(host, typed ? `There is no ${typed.number} in the list.` : "Nothing changed.");
    return;
  }
  const entry = work[index]!;
  if (typeof entry === "string") { say(host, `Nothing done: the copy's changes can't be read (${entry}). It stays at ${terminalText(found[index]!.path)}`); return; }
  if (match[1] === "Apply") await apply(host, manager, found[index]!, entry);
  else await drop(host, manager, found[index]!, entry);
}

async function startCrew(host: CrewHost, manager: GitWorktreeManager, job: string): Promise<void> {
  const left = await manager.crewCopies().catch(() => []);
  if (left.length) say(host, `${left.length} crew cop${left.length === 1 ? "y is" : "ies are"} still here from before: /crew lists ${left.length === 1 ? "it" : "them"}.`);
  const id = randomBytes(3).toString("hex");
  let copy: WorktreeRelation;
  let dirty = false;
  try {
    const plan = await manager.planCrew(id, 1, host.root);
    dirty = Boolean(plan.sourceStatus);
    copy = await manager.create(plan);
  } catch (error) {
    say(host, `Not started: ${shown(error instanceof Error ? error.message : String(error))}`);
    return;
  }
  const skipped: string[] = [];
  const note = (line: string) => { if (skipped.length < 12 && !skipped.includes(line)) skipped.push(line); };
  // A builder's commands never run without the session's shell rules around them.
  const shell = host.shell(copy.path, note);
  if (!shell) {
    await manager.remove(copy).catch(() => {});
    say(host, "Not started: this session's shell is not ready for a builder.");
    return;
  }
  const linked = await linkDependencies(manager.primaryWorkspace, copy.path);
  say(host, `Builder 1 is working in its own copy (${copy.branch}); your folder is not touched.${dirty ? " Your uncommitted changes are not in the copy." : ""}${linked.length ? ` Linked: ${linked.join(", ")}.` : ""}`);
  let result: SubagentResult;
  try {
    result = await host.runBuilder({ cwd: copy.path, goal: job, projectContext: host.projectContext,
      shell, main: manager.primaryWorkspace, ...(host.signal ? { signal: host.signal } : {}) });
  } catch (error) {
    result = { role: "builder", cwd: copy.path, goal: job, status: "failed", reason: error instanceof Error ? error.message : String(error),
      response: "", toolsUsed: [], toolErrors: [], truncated: false, usage: { tokens: 0, estimatedCost: 0 } };
  } finally { await shell.close().catch(() => {}); }

  const outcome = result.status === "completed" ? "finished" : `stopped (${result.status.replace("_", " ")}${result.reason ? `: ${shown(result.reason)}` : ""})`;
  say(host, `Builder 1 ${outcome} · ${costText(result)}`);
  if (result.response.trim()) host.write(`${terminalText(result.response.trim())}\n`);
  if (skipped.length) host.write(`[crew] Not run (it needed your OK):\n${skipped.map((line) => `  ${shown(line)}`).join("\n")}\n`);

  let work: WorktreePatch;
  try { work = await readWork(manager, copy); }
  catch (error) {
    say(host, `The copy's changes can't be read (${shown(error instanceof Error ? error.message : String(error))}). It stays at ${terminalText(copy.path)}`);
    return;
  }
  if (!work.files.length) {
    await drop(host, manager, copy, work, false);
    say(host, "No changes were made; the copy was removed.");
    return;
  }
  host.write(`[crew] Changed in the copy:\n${work.stat.split("\n").map((line) => `  ${terminalText(line.trim())}`).join("\n")}\n`);
  if (!host.canAsk()) {
    say(host, `The work stays in the copy: ${terminalText(copy.path)}. /crew applies it or throws it away.`);
    return;
  }
  const picked = await host.pick(CREW_QUESTION, crewChoices(terminalText(copy.path)), host.signal);
  if (picked === APPLY_COPY) await apply(host, manager, copy, work);
  else if (picked === DROP_COPY) await drop(host, manager, copy, work);
  else say(host, `Kept: ${terminalText(copy.path)}. /crew applies it or throws it away.`);
}
