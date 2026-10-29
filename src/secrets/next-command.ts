/**
 * Values the person typed into casper_secret's hidden box for "the next command only": the AI's next shell command gets
 * them as environment variables, and then they are gone from here. Memory only, never saved. The value itself is also a
 * typed secret (src/secrets/typed.ts), so it is hidden in that command's output and anything after it.
 */
const pending = new Map<string, string>();

/** `$name` in the AI's next command is `value`. */
export function setForNextCommand(name: string, value: string): void {
  pending.set(name, value);
}

/** The values for the command about to start, taken: the one after it gets none. */
export function takeNextCommandEnv(): Record<string, string> {
  const env = Object.fromEntries(pending);
  pending.clear();
  return env;
}

/** Drop them unused (the task ended, the conversation was cleared, Casper is closing). */
export function clearNextCommandEnv(): void {
  pending.clear();
}

/** The names waiting for the next command (never the values). */
export function nextCommandNames(): string[] {
  return [...pending.keys()];
}
