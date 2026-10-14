/** Pictures being made in the background: make_picture returns at once with the path, and anything that could touch
 * that file waits for it first: a read, edit or write of the path, and every other tool but grep, LSP and the web
 * (a shell command, a build, ls or find, the browser, casper_check, a helper may all see the folder), and the end of
 * the task. At most 3 are made at once; more queue,
 * and a second picture for the same path waits for the first. A failure goes to the call that waited for it, or once
 * to the next tool result (or the next request) when nobody did. */

import { resolveToolPath } from "../platform/project-paths";

interface Job { file: string; shown: string; done: Promise<void>; failure?: string; waited: boolean }

/** Tools that never see the project's pictures: they never wait. read, edit and write wait only for their own path. */
const NEVER_WAITS = new Set(["make_picture", "grep", "lsp", "web_search", "web_fetch"]);

export class PendingPictures {
  private readonly jobs = new Map<string, Job>();
  private readonly queue: Array<() => void> = [];
  private readonly unseen: Array<{ text: string; shown: boolean }> = [];
  private running = 0;

  /** `signal`: what stops a picture started now (the request's own cancel), read at its start. */
  constructor(private readonly signal?: () => AbortSignal | undefined, private readonly limit = 3) {}

  get size(): number { return this.jobs.size; }

  /** Starts `work` for the absolute `file` (`shown`: its project path) and returns at once. `work` throws to fail. */
  start(file: string, shown: string, work: (signal?: AbortSignal) => Promise<void>): void {
    const signal = this.signal?.();
    const before = this.jobs.get(file)?.done;
    const job: Job = { file, shown, waited: false, done: Promise.resolve() };
    job.done = (async () => {
      await before;
      await this.slot();
      try { await work(signal); }
      catch (error) { job.failure = (error instanceof Error ? error.message : String(error)).slice(0, 400); }
      finally { this.release(); }
      if (this.jobs.get(file) === job) this.jobs.delete(file);
      if (job.failure && !job.waited) this.unseen.push({ text: failureNote(job), shown: false });
    })();
    this.jobs.set(file, job);
  }

  /** Waits for the pictures this tool call would touch; returns their failures and any nobody has seen yet. */
  async before(toolName: string, input: Record<string, unknown> | undefined, root: string, signal?: AbortSignal): Promise<string[]> {
    const jobs = [...this.jobs.values()].filter(touches(toolName, input ?? {}, root));
    return [...await this.wait(jobs, signal), ...this.takeUnseen()];
  }

  /** Waits for every picture still being made (the end of a task). Returns the failures no call was told about and
   * not returned before; they stay for the model's next tool result or request (takeUnseen). */
  async settle(signal?: AbortSignal): Promise<string[]> {
    while (this.jobs.size && await until(Promise.all([...this.jobs.values()].map((job) => job.done)), signal));
    return this.unseen.filter((entry) => !entry.shown).map((entry) => { entry.shown = true; return entry.text; });
  }

  /** The failures no call was told about, once. */
  takeUnseen(): string[] { return this.unseen.splice(0).map((entry) => entry.text); }

  /** A new conversation (/clear, /resume): failures of the old one are not told to it. */
  forget(): void {
    for (const job of this.jobs.values()) job.waited = true;
    this.unseen.splice(0);
  }

  private async wait(jobs: Job[], signal?: AbortSignal): Promise<string[]> {
    if (!jobs.length) return [];
    for (const job of jobs) job.waited = true;
    if (await until(Promise.all(jobs.map((job) => job.done)), signal)) return jobs.filter((job) => job.failure).map(failureNote);
    // Cut short: what is still running reports its failure to whoever comes next, and so does one that just failed.
    for (const job of jobs) {
      if (this.jobs.get(job.file) === job) job.waited = false;
      else if (job.failure && !this.unseen.some((entry) => entry.text === failureNote(job))) this.unseen.push({ text: failureNote(job), shown: false });
    }
    return [];
  }

  private async slot(): Promise<void> {
    if (this.running < this.limit) { this.running++; return; }
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) next(); else this.running--;
  }
}

/** True when `work` finished, false when `signal` stopped the wait first. */
async function until(work: Promise<unknown>, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  let onAbort = () => {};
  const aborted = new Promise<false>((resolve) => { onAbort = () => resolve(false); signal?.addEventListener("abort", onAbort, { once: true }); });
  try { return await Promise.race([work.then(() => true as const), aborted]); }
  finally { signal?.removeEventListener("abort", onAbort); }
}

const failureNote = (job: Job) => `picture ${job.shown} failed: ${job.failure}`;

/** Which pictures a call would touch: read, edit and write their own path; every other tool all of them, since a
 * command, a build, a listing or a page may see the folder before the picture is there. */
function touches(toolName: string, input: Record<string, unknown>, root: string): (job: Job) => boolean {
  if (NEVER_WAITS.has(toolName)) return () => false;
  if (toolName === "read" || toolName === "edit" || toolName === "write") {
    if (typeof input.path !== "string") return () => false;
    // As Pi's own file tools read it: ~/ is the home folder, a leading @ is dropped and a file:// URL is its path.
    const named = resolveToolPath(input.path, root);
    const same = process.platform === "win32" || process.platform === "darwin"
      ? (file: string) => file.toLowerCase() === named.toLowerCase() : (file: string) => file === named;
    return (job) => same(job.file);
  }
  return () => true;
}
