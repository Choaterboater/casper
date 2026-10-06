/**
 * Builders the AI starts itself (the delegate tool's role builder), as Claude Code and omp do: each works in its own
 * crew copy with the same limits and sandbox as a /crew builder, and when it ends its change is applied to your
 * folder, uncommitted, with no question. Every applied file is noted like the AI's own edit, so checks, dev servers,
 * the receipt and /undo see it (one /undo takes the whole task back). A change that touches a file changed in your
 * folder since the copy started is not forced in: the copy is kept (/crew lists it) and the AI is told.
 */
import { randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { BuilderRunOptions, BuildOutcome, DelegateBuilders, SubagentResult } from "../agents/manager";
import type { RuntimeShell } from "../runtime/types";
import { redactPreview } from "../tui/format";
import { GitWorktreeManager, type WorktreePatch, type WorktreeRelation } from "../workspace/worktree";
import { costText } from "./command";
import { linkDependencies, unlinkDependencies } from "./copies";

export interface AutoBuildHost {
  /** The project folder the change lands in. */
  root: string;
  homeDir: string;
  /** The project's rules and facts, as a helper gets them. */
  projectContext: string;
  runBuilder(options: BuilderRunOptions): Promise<SubagentResult>;
  /** The builder's shell around its copy; `note` gets what was not run because it needed your OK. */
  shell(copy: string, note: (line: string) => void): (RuntimeShell & { close(): Promise<void> }) | undefined;
  /** One applied file, told to the session as the AI's own edit. */
  observeEdit(file: string): void;
  /** A line for the person ("[crew] ..."). */
  say(line: string): void;
}

/** Words in the request that steer builders for this task. "solo" wins over "split". */
export type BuilderSteer = "split" | "solo" | undefined;

const SOLO = /\b(?:no helpers?|without (?:any )?helpers?|no builders?|by yourself|on your own|do it yourself|yourself only)\b/i;
const SPLIT = /(?<![/\w-])crew\b|\bsplit (?:this|it|the (?:work|job))(?: up)?\b|\bsplit up\b|\bin parallel\b/i;

export function builderSteer(request: string): BuilderSteer {
  if (SOLO.test(request)) return "solo";
  return SPLIT.test(request) ? "split" : undefined;
}

/** The one line the task's text gets for a steer (only when builders are offered). */
export function builderSteerLine(steer: BuilderSteer): string | undefined {
  if (steer === "split") return "Split this job: give each independent part to a builder (delegate, role builder) at the same time, with separate files each; do the rest yourself.";
  if (steer === "solo") return "Do this yourself: no builders this time.";
  return undefined;
}

export const SOLO_REFUSAL = "The request said to work alone: no builders this task. Do the work yourself.";

/** Why builders can't run here, or undefined when they can. */
export async function builderAvailability(input: { root: string; homeDir: string; off: boolean; sandbox: "ready" | "none" | "asks" }): Promise<string | undefined> {
  if (input.off) return "turned off in /settings (Helpers that build)";
  if (input.sandbox === "none") return "this session's shell is not ready for them";
  if (input.sandbox === "asks") return "no sandbox runs here, so their commands could not run";
  const manager = await GitWorktreeManager.open(input.root, input.homeDir);
  if (!manager) return "this folder is not a Git repository";
  const root = await realpath(input.root).catch(() => path.resolve(input.root));
  return root === manager.primaryWorkspace ? undefined : "builders start from the project's main folder, not a branch copy";
}

/** Applies and copy-making take turns per repository: one builder's change lands before the next copy is made. */
const turns = new Map<string, Promise<unknown>>();
async function inTurn<T>(key: string, work: () => Promise<T>): Promise<T> {
  const before = turns.get(key) ?? Promise.resolve();
  const next = before.catch(() => {}).then(work);
  turns.set(key, next);
  try { return await next; }
  finally { if (turns.get(key) === next) turns.delete(key); }
}

const shown = (text: string) => redactPreview(text).replace(/\s+/g, " ").trim();
const message = (error: unknown) => shown(error instanceof Error ? error.message : String(error));

/** The delegate tool's builders for this task. */
export function autoBuilders(host: AutoBuildHost, off: string | undefined, steer: BuilderSteer): DelegateBuilders {
  return {
    ...(off ? { off } : {}),
    refuse: () => steer === "solo" ? SOLO_REFUSAL : undefined,
    run: (job) => runAutoBuilder(host, job),
  };
}

export async function runAutoBuilder(host: AutoBuildHost, job: { goal: string; context?: string; signal?: AbortSignal }): Promise<BuildOutcome> {
  const manager = await GitWorktreeManager.open(host.root, host.homeDir);
  if (!manager) throw new Error("No builders here: this folder is not a Git repository");
  const id = randomBytes(3).toString("hex");
  const copy = await inTurn(manager.commonDir, async () => manager.create(await manager.planCrew(id, 1, host.root)));
  const notRun: string[] = [];
  const note = (line: string) => { if (notRun.length < 12 && !notRun.includes(line)) notRun.push(shown(line)); };
  const shell = host.shell(copy.path, note);
  if (!shell) {
    await manager.remove(copy).catch(() => {});
    throw new Error("No builders here: this session's shell is not ready for them");
  }
  await linkDependencies(manager.primaryWorkspace, copy.path);
  host.say(`A builder is working in its own copy (${copy.branch}): ${shown(job.goal).slice(0, 80)}`);
  let result: SubagentResult;
  try {
    result = await host.runBuilder({ cwd: copy.path, goal: job.goal, projectContext: host.projectContext, shell, main: manager.primaryWorkspace,
      ...(job.context ? { context: job.context } : {}), ...(job.signal ? { signal: job.signal } : {}) });
  } catch (error) {
    result = { role: "builder", cwd: copy.path, goal: job.goal, status: "failed", reason: message(error),
      response: "", toolsUsed: [], toolErrors: [], truncated: false, usage: { tokens: 0, estimatedCost: 0 } };
  } finally { await shell.close().catch(() => {}); }

  const outcome = (fields: Record<string, unknown>): BuildOutcome => {
    const isError = result.status !== "completed" || "kept" in fields;
    return { isError, usage: result.usage, report: {
      isError, status: result.status, ...(result.reason ? { reason: result.reason } : {}), ...fields,
      ...(notRun.length ? { notRun } : {}),
      cost: costText(result), toolErrors: result.toolErrors, truncated: result.truncated, report: result.response,
    } };
  };
  const keep = (why: string, work?: WorktreePatch) => {
    host.say(`A builder's work was not applied (${why}). It stays in its copy; /crew lists it.`);
    return outcome({ applied: [], ...(work ? { changedInCopy: work.files } : {}), kept: { copy: copy.path, why } });
  };

  let work: WorktreePatch;
  try { await unlinkDependencies(copy.path); work = await manager.capturePatch(copy); }
  catch (error) { return keep(`its changes can't be read: ${message(error)}`); }
  if (!work.files.length) {
    await manager.remove(copy, work).catch(() => {});
    return outcome({ applied: [], note: "No changes were made; the copy was removed." });
  }
  // Only a builder that finished lands by itself; a stopped one may have left half a change.
  if (result.status !== "completed") return keep(`the builder ${result.status === "cancelled" ? "was stopped" : `did not finish (${result.status.replace("_", " ")})`}`, work);
  const applied = await inTurn(manager.commonDir, () => apply(manager, copy, work));
  if (typeof applied === "string") return keep(applied, work);
  for (const file of work.files) host.observeEdit(path.join(manager.primaryWorkspace, file));
  await manager.remove(copy, work).catch(() => {});
  host.say(`A builder's change was applied to your folder, uncommitted: ${work.files.slice(0, 6).join(", ")}${work.files.length > 6 ? ` and ${work.files.length - 6} more` : ""}.`);
  return outcome({ applied: work.files, stat: work.stat });
}

/** Undefined when applied; else why not. */
async function apply(manager: GitWorktreeManager, copy: WorktreeRelation, work: WorktreePatch): Promise<string | undefined> {
  try { await manager.applyCrew(copy, work); return undefined; }
  catch (error) { return message(error); }
}
