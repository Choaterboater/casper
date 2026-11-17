/** Wakes: requests Casper itself starts for the AI when something it watches for the person changed (a pull request
 * watch, src/github/watch.ts). One runs when the prompt is idle, in place of a typed line, or after the request that
 * runs now and the lines typed during it. It is never typed by the person: none of the typed-word rules ("big model:",
 * "!command") apply, and it is not echoed as a typed line. One per source waits at a time: a later change adds its
 * reasons to the one still waiting. */

export interface Wake {
  /** One source (a watched pull request): its waiting wake is joined, not repeated. */
  key: string;
  reasons: string[];
  /** The request the AI gets, from every reason gathered while it waited. */
  text(reasons: readonly string[]): string;
  /** The line the person sees when it runs. */
  line(reasons: readonly string[]): string;
}

export class Wakes {
  private readonly queue: Wake[] = [];
  private readonly listeners = new Set<() => void>();

  push(wake: Wake): void {
    const waiting = this.queue.find((entry) => entry.key === wake.key);
    if (waiting) {
      for (const reason of wake.reasons) if (!waiting.reasons.includes(reason)) waiting.reasons.push(reason);
      waiting.text = wake.text;
      waiting.line = wake.line;
    } else this.queue.push({ ...wake, reasons: [...wake.reasons] });
    for (const listener of [...this.listeners]) listener();
  }

  /** The next wake's request and line, oldest first. */
  take(): { text: string; line: string } | undefined {
    const next = this.queue.shift();
    return next ? { text: next.text(next.reasons), line: next.line(next.reasons) } : undefined;
  }

  /** A watch that ended: its waiting wake goes too. */
  drop(key: string): void {
    const index = this.queue.findIndex((entry) => entry.key === key);
    if (index >= 0) this.queue.splice(index, 1);
  }

  get size(): number { return this.queue.length; }

  /** Settles when a wake is waiting (at once when one is); `cancel` stops listening. */
  arrived(): { promise: Promise<void>; cancel(): void } {
    const { promise, resolve } = Promise.withResolvers<void>();
    if (this.queue.length) { resolve(); return { promise, cancel() {} }; }
    const listener = () => { this.listeners.delete(listener); resolve(); };
    this.listeners.add(listener);
    return { promise, cancel: () => { this.listeners.delete(listener); } };
  }
}
