/**
 * /tasks: one numbered list of what Casper keeps running in the background (dev servers, the browser, the debugger,
 * helpers, checks) and one numbered question to stop one. Choice 1 keeps everything running; Enter picks it.
 */
import { hideCommandSecrets } from "../secrets/files";
import { redactPreview } from "../tui/format";

/** A name on screen: a helper's goal is the model's own words, so the full secret rules run first. */
function shown(text: string, max: number): string {
  return redactPreview(hideCommandSecrets(text).text).replace(/\s+/g, " ").slice(0, max);
}
import type { Choice } from "./safe-choices";

export type BackgroundKind = "dev server" | "browser" | "debugger" | "helper" | "checks";

export interface BackgroundTask {
  kind: BackgroundKind;
  /** What it is, in a few words ("api", "explorer: find the login code"). */
  name: string;
  /** Plain status: "running", "starting", "stale (restarts before next use)". */
  status: string;
  /** When it started, when known. */
  startedAt?: number;
  /** Stops it. Resolves what happened, in plain words ("Stopped api."). */
  stop(): Promise<string>;
}

/** 95 s → "1m", 3 h 4 m → "3h04m"; under a minute is "just now". */
export function sinceText(startedAt: number | undefined, now = Date.now()): string {
  if (startedAt === undefined) return "";
  const minutes = Math.floor(Math.max(0, now - startedAt) / 60_000);
  if (!minutes) return " · just started";
  const hours = Math.floor(minutes / 60);
  return ` · for ${hours ? `${hours}h${String(minutes % 60).padStart(2, "0")}m` : `${minutes}m`}`;
}

/** "Running in the background:\n  1 dev server api · running · for 4m\n" or the plain "Nothing is running". */
export function formatBackgroundTasks(tasks: readonly BackgroundTask[], now = Date.now()): string {
  if (!tasks.length) return "[tasks] Nothing is running in the background.\n";
  return `[tasks] Running in the background:\n${tasks.map((task, index) =>
    `  ${index + 1} ${task.kind} ${shown(task.name, 80)} · ${task.status}${sinceText(task.startedAt, now)}`).join("\n")}\n`;
}

export const TASKS_QUESTION = "Stop something?";

/** "1 Keep them · 2 Stop 1 · 3 Stop 2 · 4 Stop all". Enter keeps everything running. */
export function tasksChoices(tasks: readonly BackgroundTask[]): Choice[] {
  if (!tasks.length) return [];
  return [
    { label: tasks.length === 1 ? "Leave it running" : "Keep them", description: "nothing is stopped" },
    ...tasks.map((task, index) => ({ label: `Stop ${index + 1}`, description: `${task.kind} ${shown(task.name, 60)}` })),
    ...(tasks.length > 1 ? [{ label: "Stop all", description: `all ${tasks.length}` }] : []),
  ];
}

export interface TasksHost {
  tasks(): BackgroundTask[];
  write(text: string): void;
  /** Someone can answer a numbered question (an open Casper at a terminal). */
  canAsk(): boolean;
  pick(question: string, options: Choice[], signal?: AbortSignal): Promise<string | undefined>;
  signal?: AbortSignal;
  /** A task is running: a bare /tasks lists and says how to stop one, with no question (a box could open any moment). */
  duringWork?: boolean;
}

/** The /tasks command. A one-shot run or a pipe never waits on the question: it lists and stops nothing. */
export async function runTasksCommand(host: TasksHost, argument = ""): Promise<void> {
  // "/tasks stop 2" or "/tasks stop all" is the same choice, typed ahead. Anything else is a usage error, even with
  // nothing running.
  const typed = /^stop\s+(\d+|all)$/i.exec(argument.trim());
  if (argument.trim() && !typed) throw new Error("Usage: /tasks | /tasks stop <n> | /tasks stop all");
  const tasks = host.tasks();
  host.write(formatBackgroundTasks(tasks));
  if (!tasks.length) return;
  let picked: string | undefined;
  if (typed) picked = typed[1]!.toLowerCase() === "all" ? "Stop all" : `Stop ${typed[1]}`;
  else if (host.duringWork) { host.write("[tasks] To stop one now: /tasks stop <n> (or /tasks stop all).\n"); return; }
  else if (!host.canAsk()) { host.write("[tasks] Nothing was stopped: nobody is here to answer. To stop one: /tasks stop <n>\n"); return; }
  else picked = await host.pick(TASKS_QUESTION, tasksChoices(tasks), host.signal);
  const number = /^Stop (\d+)$/.exec(picked ?? "")?.[1];
  const chosen = picked === "Stop all" ? tasks : number && Number(number) >= 1 && Number(number) <= tasks.length ? [tasks[Number(number) - 1]!] : [];
  if (!chosen.length) {
    host.write(typed ? `[tasks] There is no ${typed[1]} in the list.\n` : "[tasks] Nothing was stopped.\n");
    return;
  }
  for (const task of chosen) {
    try { host.write(`[tasks] ${await task.stop()}\n`); }
    catch (error) { host.write(`[tasks] Could not stop ${task.kind} ${shown(task.name, 80)}: ${redactPreview(error instanceof Error ? error.message : String(error))}\n`); }
  }
}
