/**
 * A line the person sends the AI during a task ends a step that only waits, so the AI reads the line now: Pi reads a
 * steered line only once every tool call of the step has ended (pi-agent-core's agent loop). Each such wait listens
 * while it waits: the browser's sign-in window, a slow shell command (it moves to the background) and a service start.
 */
export class SteerWaits {
  private readonly ends = new Set<() => void>();

  /** Calls `end` once if a line reaches the AI before the returned function is called (the wait ended another way). */
  readonly listen = (end: () => void): (() => void) => {
    const once = () => { this.ends.delete(once); end(); };
    this.ends.add(once);
    return () => { this.ends.delete(once); };
  };

  /** A line reached the AI: every wait listening now ends. Returns how many did. */
  steered(): number {
    const ends = [...this.ends];
    for (const end of ends) {
      try { end(); } catch { /* one wait's failure never keeps the others waiting */ }
    }
    return ends.length;
  }
}
