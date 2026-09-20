/** JSON escapes C0 controls; also escape DEL/C1 and bidi controls for terminal output.
 * Parseable values are preserved. Use this same encoding when measuring result budgets. */
export function formatTerminalJSON(value: unknown): string {
  return (JSON.stringify(value) ?? "null").replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu,
    (char) => `\\u${char.codePointAt(0)!.toString(16).padStart(4, "0")}`);
}
