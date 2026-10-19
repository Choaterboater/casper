/**
 * Catches a model that keeps making the same call with nothing changed in between (borrowed from omp's
 * tool-call-loop-guard, Gemini CLI's loop detection and opencode). The 3rd identical call gets a short note;
 * from the 5th it is not run again and the model gets the earlier result back with a "skipped" note.
 *
 * Only reads of the project's files are counted: read, grep, find and ls give the same answer until a file
 * changes. Every other tool resets the counts: edit, write and the shell change things, and the rest (browser,
 * web, MCP, checks, helpers) either change things too or answer from something that changes on its own, such as
 * a page after a click or a server's state, so a repeat of them can be a real wait and is never blocked.
 *
 * A shell command Casper refused ("Not run: ...") is the exception: nothing ran, and the same words are refused again
 * for the rest of the request, whatever else happens in between. A small model sent one refused command 76 times;
 * its repeats are counted apart from the reads and kept until the next request.
 */
const COUNTED = new Set(["read", "grep", "find", "ls"]);
const NOTE_AT = 3;
const SKIP_AT = 5;
const SUMMARY_CHARS = 1500;

export const REPEAT_NOTE = "You already ran this with nothing changed since; the result will be the same.";
export const REFUSED_NOTE = "This exact command was refused again and will be refused for the rest of this request. Don't send it again; do something else.";
const SHELLS = new Set(["bash", "powershell"]);
const REFUSED = /^Not run:/;

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
  private readonly refused = new Map<string, { count: number; summary: string }>();

  private shellKey(toolName: string, input: unknown): string | undefined {
    const command = SHELLS.has(toolName) ? Reflect.get(Object(input), "command") : undefined;
    return typeof command === "string" ? `${toolName}\0${command.trim()}` : undefined;
  }

  private key(toolName: string, input: unknown): string | undefined {
    if (!COUNTED.has(toolName)) return undefined;
    try { return `${toolName}\0${JSON.stringify(stable(input))}`; } catch { return undefined; }
  }

  /** Before a call runs: the reason to skip it, or undefined to run it. Any uncounted tool resets the counts. */
  before(id: string, toolName: string, input: unknown): string | undefined {
    const shell = this.shellKey(toolName, input);
    const refused = shell === undefined ? undefined : this.refused.get(shell);
    if (refused && refused.count + 1 >= SKIP_AT) {
      refused.count++;
      this.skipped.add(id);
      return `Skipped as a repeat: this exact command was refused ${refused.count - 1} times in this request and would be refused again. Do something else. It said:\n${refused.summary}`;
    }
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
    const text = texts.join("\n");
    const shell = this.shellKey(toolName, input);
    if (shell !== undefined) {
      if (!REFUSED.test(text)) { this.refused.delete(shell); return undefined; }
      const count = (this.refused.get(shell)?.count ?? 0) + 1;
      this.refused.set(shell, { count, summary: text.slice(0, SUMMARY_CHARS) });
      return count >= NOTE_AT ? REFUSED_NOTE : undefined;
    }
    const key = this.key(toolName, input);
    if (key === undefined) return undefined;
    const summary = text.length > SUMMARY_CHARS ? `${text.slice(0, SUMMARY_CHARS)}\n[...]` : text;
    const count = (this.seen.get(key)?.count ?? 0) + 1;
    this.seen.set(key, { count, summary });
    return count >= NOTE_AT ? REPEAT_NOTE : undefined;
  }

  /** A new request: the person may have changed files meanwhile. */
  reset(): void { this.seen.clear(); this.skipped.clear(); this.refused.clear(); }
}
