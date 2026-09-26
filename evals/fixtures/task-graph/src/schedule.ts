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

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const has = (graph: Graph, key: string) => Object.prototype.hasOwnProperty.call(graph, key);

function dependencies(graph: Graph): Map<string, string[]> {
  const names = Object.keys(graph).sort(byName);
  const resolved = new Map<string, string[]>();
  for (const task of names) {
    const own = new Set<string>();
    for (const dependency of graph[task]!) {
      // `name?` is optional: ignored when there is no such task, an ordinary dependency otherwise.
      const optional = dependency.endsWith("?");
      const name = optional ? dependency.slice(0, -1) : dependency;
      if (has(graph, name)) own.add(name);
      else if (!optional) throw new MissingDependencyError(task, dependency);
    }
    resolved.set(task, [...own].sort(byName));
  }
  return resolved;
}

/** The shortest cycle back to `start` (lexicographically smallest among the shortest), or undefined. */
function cycleThrough(start: string, deps: Map<string, string[]>): string[] | undefined {
  const parent = new Map<string, string>();
  const queue = [start];
  const seen = new Set<string>();
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head]!;
    for (const next of deps.get(node)!) {
      if (next === start) {
        const path: string[] = [];
        for (let at = node; at !== start; at = parent.get(at)!) path.unshift(at);
        return [start, ...path, start];
      }
      if (seen.has(next)) continue;
      seen.add(next);
      parent.set(next, node);
      queue.push(next);
    }
  }
  return undefined;
}

function layers(graph: Graph, limit = Number.POSITIVE_INFINITY): string[][] {
  const deps = dependencies(graph);
  const done = new Set<string>();
  const result: string[][] = [];
  while (done.size < deps.size) {
    const ready = [...deps.keys()].filter((task) => !done.has(task) && deps.get(task)!.every((dependency) => done.has(dependency)));
    if (ready.length === 0) {
      for (const task of [...deps.keys()].filter((name) => !done.has(name))) {
        const cycle = cycleThrough(task, deps);
        if (cycle) throw new CycleError(cycle);
      }
    }
    const batch = ready.slice(0, limit);
    for (const task of batch) done.add(task);
    result.push(batch);
  }
  return result;
}

export interface BatchOptions {
  /** Most tasks per batch: a positive integer. When more are ready, the smallest names go first. */
  readonly limit?: number;
}

/** Groups that can run in parallel: each task sits in the first batch after all of its dependencies
 * that still has room. */
export function batches(graph: Graph, options: BatchOptions = {}): string[][] {
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  if (options.limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new RangeError("limit must be a positive integer");
  return layers(graph, limit);
}

/** One order: whenever several tasks are ready, the smallest name goes first. */
export function schedule(graph: Graph): string[] {
  const deps = dependencies(graph);
  layers(graph);
  const done = new Set<string>();
  const order: string[] = [];
  while (order.length < deps.size) {
    const next = [...deps.keys()].find((task) => !done.has(task) && deps.get(task)!.every((dependency) => done.has(dependency)))!;
    done.add(next);
    order.push(next);
  }
  return order;
}
