export type JobResult<T> =
  | { readonly status: "fulfilled"; readonly value: T }
  | { readonly status: "rejected"; readonly error: unknown }
  | { readonly status: "cancelled" };

export type Job<T> = (signal: AbortSignal) => Promise<T> | T;

export interface JobHandle<T> {
  /** 1 for the first job added to this queue, then 2, 3, ... */
  readonly id: number;
  /** Settles once with the job's outcome; never rejects. */
  readonly result: Promise<JobResult<T>>;
  cancel(): void;
}

export interface AddOptions {
  /** Higher starts first; equal priorities start in the order added. Default 0. */
  readonly priority?: number;
}

export interface QueueOptions {
  /** How many jobs may run at once: a positive integer. */
  readonly concurrency: number;
  /** Extra attempts after a failed one: a non-negative integer, default 0. */
  readonly retries?: number;
  /** Waits before a retry. Defaults to a real timer; tests inject their own. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const realSleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
});

interface Entry {
  readonly id: number;
  readonly job: Job<unknown>;
  readonly controller: AbortController;
  readonly resolve: (result: JobResult<unknown>) => void;
  readonly priority: number;
  state: "queued" | "running" | "done";
  settled?: JobResult<unknown>;
}

export class JobQueue {
  readonly #concurrency: number;
  readonly #retries: number;
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly #all: Entry[] = [];
  readonly #waiting: Entry[] = [];
  readonly #idle: Array<(results: JobResult<unknown>[]) => void> = [];
  #running = 0;
  #paused = false;

  constructor(options: QueueOptions) {
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1) throw new RangeError("concurrency must be a positive integer");
    const retries = options.retries ?? 0;
    if (!Number.isInteger(retries) || retries < 0) throw new RangeError("retries must be a non-negative integer");
    this.#concurrency = options.concurrency;
    this.#retries = retries;
    this.#sleep = options.sleep ?? realSleep;
  }

  /** Jobs waiting to start. */
  get size(): number {
    return this.#waiting.length;
  }

  /** Jobs holding a slot: running, waiting to retry, or cancelled but not yet settled. */
  get pending(): number {
    return this.#running;
  }

  /** Start no new jobs until `resume()`; running jobs go on. */
  pause(): void {
    this.#paused = true;
  }

  resume(): void {
    this.#paused = false;
    this.#pump();
  }

  add<T>(job: Job<T>, options: AddOptions = {}): JobHandle<T> {
    let resolve!: (result: JobResult<unknown>) => void;
    const result = new Promise<JobResult<unknown>>((settle) => { resolve = settle; });
    const entry: Entry = { id: this.#all.length + 1, job, controller: new AbortController(), resolve, priority: options.priority ?? 0, state: "queued" };
    this.#all.push(entry);
    const before = this.#waiting.findIndex((queued) => queued.priority < entry.priority);
    this.#waiting.splice(before < 0 ? this.#waiting.length : before, 0, entry);
    this.#pump();
    return { id: entry.id, result: result as Promise<JobResult<T>>, cancel: () => this.#cancel(entry) };
  }

  /** Resolves once nothing is queued or running, with every job's result in the order the jobs were added. */
  onIdle(): Promise<JobResult<unknown>[]> {
    return new Promise((resolve) => {
      this.#idle.push(resolve);
      this.#checkIdle();
    });
  }

  #settle(entry: Entry, result: JobResult<unknown>): void {
    if (entry.settled) return;
    entry.settled = result;
    entry.resolve(result);
  }

  #cancel(entry: Entry): void {
    if (entry.settled) return;
    entry.controller.abort();
    this.#settle(entry, { status: "cancelled" });
    if (entry.state === "queued") {
      this.#waiting.splice(this.#waiting.indexOf(entry), 1);
      entry.state = "done";
      this.#checkIdle();
    }
  }

  #pump(): void {
    while (!this.#paused && this.#running < this.#concurrency && this.#waiting.length > 0) {
      const entry = this.#waiting.shift()!;
      entry.state = "running";
      this.#running++;
      void this.#run(entry).finally(() => {
        entry.state = "done";
        this.#running--;
        this.#pump();
        this.#checkIdle();
      });
    }
  }

  async #run(entry: Entry): Promise<void> {
    const signal = entry.controller.signal;
    for (let attempt = 0; ; attempt++) {
      try {
        const value = await entry.job(signal);
        this.#settle(entry, { status: "fulfilled", value });
        return;
      } catch (error) {
        if (signal.aborted) return;
        if (attempt >= this.#retries) {
          this.#settle(entry, { status: "rejected", error });
          return;
        }
      }
      await this.#sleep(Math.min(10 * 2 ** attempt, 100), signal);
      if (signal.aborted) return;
    }
  }

  #checkIdle(): void {
    if (this.#running > 0 || this.#waiting.length > 0) return;
    const results = this.#all.map((entry) => entry.settled!);
    for (const resolve of this.#idle.splice(0)) resolve(results);
  }
}
