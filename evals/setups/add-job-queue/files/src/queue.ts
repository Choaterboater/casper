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

export interface QueueOptions {
  /** How many jobs may run at once: a positive integer. */
  readonly concurrency: number;
  /** Extra attempts after a failed one: a non-negative integer, default 0. */
  readonly retries?: number;
  /** Waits before a retry. Defaults to a real timer; tests inject their own. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export class JobQueue {
  constructor(_options: QueueOptions) {}

  add<T>(_job: Job<T>): JobHandle<T> {
    throw new Error("not implemented");
  }

  /** Resolves once nothing is queued or running, with every job's result in the order the jobs were added. */
  onIdle(): Promise<JobResult<unknown>[]> {
    throw new Error("not implemented");
  }
}
