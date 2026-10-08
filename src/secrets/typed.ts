/**
 * Secrets you typed into one of Casper's own hidden boxes this session (an ssh password or key passphrase). They live in
 * memory only, are never saved, and are hidden wherever text could reach the AI: tool output, MCP results, command
 * previews, reference excerpts, model replies.
 *
 * There is deliberately no length floor: a 3-character password is still a password. The cost is that a short secret also
 * hides the same letters in ordinary text (a password of "e" hides every "e" in what the AI reads) until it is forgotten.
 *
 * A "Yes, this once" value is forgotten when the next command starts (the result of the command it was typed for has been
 * hidden by then); a "Yes, for this session" value, and any other, when the conversation is cleared, the workspace
 * changes or Casper ends.
 */
const typed = new Set<string>();
const once = new Set<string>();

/** Hide `value` from now on. An empty value is ignored (it would match everywhere). `onlyOnce`: see forgetOnceSecrets. */
export function rememberTypedSecret(value: string, onlyOnce = false): void {
  if (!value) return;
  typed.add(value);
  if (onlyOnce) once.add(value);
  else once.delete(value);
}

/** The typed secrets, longest first. */
export function typedSecretValues(): string[] {
  return [...typed].sort((a, b) => b.length - a.length);
}

/** Forget the values typed for "Yes, this once". */
export function forgetOnceSecrets(): void {
  for (const value of once) typed.delete(value);
  once.clear();
}

/** Forget them all. */
export function forgetTypedSecrets(): void {
  typed.clear();
  once.clear();
}
