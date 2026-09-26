export type Graph = Readonly<Record<string, readonly string[]>>;

export class MissingDependencyError extends Error {
  constructor(readonly task: string, readonly dependency: string) {
    super(`${task} depends on unknown task ${dependency}`);
    this.name = "MissingDependencyError";
  }
}

export class CycleError extends Error {
  /** Starts and ends with the same task, following dependencies: `["a", "b", "a"]` means a needs b needs a. */
  constructor(readonly cycle: readonly string[]) {
    super(`cycle: ${cycle.join(" -> ")}`);
    this.name = "CycleError";
  }
}

export interface BatchOptions {
  /** Most tasks per batch: a positive integer. When more are ready, the smallest names go first. */
  readonly limit?: number;
}

/** Groups that can run in parallel: each task sits in the first batch after all of its dependencies
 * that still has room. */
export function batches(_graph: Graph, _options: BatchOptions = {}): string[][] {
  throw new Error("not implemented");
}

/** One order: whenever several tasks are ready, the smallest name goes first. */
export function schedule(_graph: Graph): string[] {
  throw new Error("not implemented");
}
