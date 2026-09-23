/** One owned subsystem with an idempotent close. */
export interface OwnedClose {
  /** Stable registry key, e.g. "mcp", "browser". */
  readonly name: string;
  close(): Promise<void>;
}

interface Registered {
  readonly entry: OwnedClose;
  /** Started close for this registration, if any. Callers join it; never restarted. */
  close?: Promise<void>;
}

/** Ordered bookkeeping for owned subsystem teardown. The first close per registration starts
 * the close; later callers await the same outcome. A settled registration is retired unless it
 * was replaced (cancel → new session under the same name), so a replacement is closed by the
 * next `closeAll()`. `drain()` awaits every started close, including one whose registration
 * was replaced mid-flight, and propagates the first failure to the owner — matching the
 * previous concurrent `Promise.all` over close promises. */
export class LifecycleRegistry {
  private readonly registered = new Map<string, Registered>();
  private readonly pending = new Set<Promise<void>>();

  add(entry: OwnedClose): void {
    this.registered.set(entry.name, { entry });
  }

  /** Start (or join) one subsystem's close. Unknown names resolve immediately. */
  close(name: string): Promise<void> {
    const slot = this.registered.get(name);
    if (!slot) return Promise.resolve();
    slot.close ??= slot.entry.close();
    const work = slot.close;
    this.pending.add(work);
    // Callers receive `work` and handle its rejection; the bookkeeping chain must not
    // surface it a second time as an unhandled rejection.
    work.finally(() => {
      this.pending.delete(work);
      // Retire only while this registration is still current; a replacement stays closeable.
      if (this.registered.get(name) === slot) this.registered.delete(name);
    }).catch(() => {});
    return work;
  }

  /** Start every registered close (cancel/quit path); rejections are returned, not swallowed. */
  closeAll(): Promise<void>[] {
    return [...this.registered.keys()].map(name => this.close(name));
  }

  /** Await every started close; the first failure propagates. */
  async drain(): Promise<void> {
    await Promise.all([...this.pending]);
  }
}
