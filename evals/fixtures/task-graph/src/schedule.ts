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
  for (const task of names) {
    for (const dependency of graph[task]!) if (!has(graph, dependency)) throw new MissingDependencyError(task, dependency);
  }
  return new Map(names.map((task) => [task, [...new Set(graph[task]!)].sort(byName)]));
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

function layers(graph: Graph): string[][] {
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
    for (const task of ready) done.add(task);
    result.push(ready);
  }
  return result;
}

/** Groups that can run in parallel: each task sits in the first batch after all of its dependencies. */
export function batches(graph: Graph): string[][] {
  return layers(graph);
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
