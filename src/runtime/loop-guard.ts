/**
 * Catches a model that keeps making the same call with nothing changed in between (borrowed from omp's
 * tool-call-loop-guard, Gemini CLI's loop detection and opencode). The 3rd identical call gets a short note;
 * from the 5th it is not run again and the model gets the earlier result back with a "skipped" note.
 *
 * Only reads of the project's files are counted: read, grep, find and ls give the same answer until a file
 * changes. Every other tool resets the counts: edit, write and the shell change things, and the rest (browser,
 * web, MCP, checks, helpers) either change things too or answer from something that changes on its own, such as
 * a page after a click or a server's state, so a repeat of them can be a real wait and is never blocked.
 */
const COUNTED = new Set(["read", "grep", "find", "ls"]);
const NOTE_AT = 3;
const SKIP_AT = 5;
const SUMMARY_CHARS = 1500;

export const REPEAT_NOTE = "You already ran this with nothing changed since; the result will be the same.";

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable((value as Record<string, unknown>)[key])]));
  }
  return value;
}

export class LoopGuard {
  private readonly seen = new Map<string, { count: number; summary: string }>();
  private readonly skipped = new Set<string>();

  private key(toolName: string, input: unknown): string | undefined {
    if (!COUNTED.has(toolName)) return undefined;
    try { return `${toolName}\0${JSON.stringify(stable(input))}`; } catch { return undefined; }
  }

  /** Before a call runs: the reason to skip it, or undefined to run it. Any uncounted tool resets the counts. */
  before(id: string, toolName: string, input: unknown): string | undefined {
    const key = this.key(toolName, input);
    if (key === undefined) { this.seen.clear(); return undefined; }
    const entry = this.seen.get(key);
    if (!entry || entry.count + 1 < SKIP_AT) return undefined;
    entry.count++;
    this.skipped.add(id);
    return `Skipped as a repeat: this exact ${toolName} call already ran with nothing changed since. Its result was:\n${entry.summary}`;
  }

  /** After a call ran: the note to add to its result, if it is a repeat. */
  after(id: string, toolName: string, input: unknown, texts: string[]): string | undefined {
    if (this.skipped.delete(id)) return undefined;
    const key = this.key(toolName, input);
    if (key === undefined) return undefined;
    const text = texts.join("\n");
    const summary = text.length > SUMMARY_CHARS ? `${text.slice(0, SUMMARY_CHARS)}\n[...]` : text;
    const count = (this.seen.get(key)?.count ?? 0) + 1;
    this.seen.set(key, { count, summary });
    return count >= NOTE_AT ? REPEAT_NOTE : undefined;
  }

  /** A new request: the person may have changed files meanwhile. */
  reset(): void { this.seen.clear(); this.skipped.clear(); }
}
