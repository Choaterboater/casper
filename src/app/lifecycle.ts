/** One owned subsystem with an idempotent close. */
export interface OwnedClose {
  /** Stable registry key, e.g. "mcp", "browser". */
  readonly name: string;
  close(): Promise<void>;
}

/** Ordered bookkeeping for owned subsystem teardown. The first close call per name starts the
 * close; every later caller awaits the same outcome. `drain()` propagates the first failure to
 * the owner, matching the previous concurrent `Promise.all` over close promises. */
export class LifecycleRegistry {
  private readonly entries = new Map<string, OwnedClose>();
  private readonly work = new Map<string, Promise<void>>();

  add(entry: OwnedClose): void {
    this.entries.set(entry.name, entry);
  }

  /** Start (or join) one subsystem's close. Unknown names resolve immediately. */
  close(name: string): Promise<void> {
    const started = this.work.get(name);
    if (started) return started;
    const entry = this.entries.get(name);
    if (!entry) return Promise.resolve();
    const work = entry.close();
    this.work.set(name, work);
    return work;
  }

  /** Start every registered close (cancel/quit path); rejections are returned, not swallowed. */
  closeAll(): Promise<void>[] {
    return [...this.entries.keys()].map(name => this.close(name));
  }

  /** Await every started close; the first failure propagates. */
  async drain(): Promise<void> {
    await Promise.all([...this.work.values()]);
  }
}
