import { LINE_MARKER, SECRET_MARKER } from "./scrub";

/** Refusal for a native edit or write whose new text still holds the marker. */
export const NOT_WRITTEN_REASON = `Not written: the new text has ${SECRET_MARKER} in it. That would replace a real secret in the file. Keep the original line.`;
/** Refusal for a shell command that holds the marker (sed -i, echo >, a script...). */
export const NOT_RUN_REASON = `Not run: the command has ${SECRET_MARKER} in it. It could write the marker over a real secret. Keep the original line, or ask the user to make this change.`;

const OLD_TEXT_KEYS = new Set(["oldText", "old_text", "old_string", "oldString", "path"]);

function hasMarker(value: unknown, depth = 0): boolean {
  if (typeof value === "string") return value.includes(SECRET_MARKER) || value.includes(LINE_MARKER);
  if (!value || typeof value !== "object" || depth > 16) return false;
  if (Array.isArray(value)) return value.some((entry) => hasMarker(entry, depth + 1));
  // Old text only has to match the file; it never writes anything.
  return Object.entries(value).some(([key, entry]) => !OLD_TEXT_KEYS.has(key) && hasMarker(entry, depth + 1));
}

/**
 * The hidden-secret check for native tools. The AI only ever saw "<secret hidden>", so new text or
 * a command that carries it back would overwrite a real secret with the marker.
 */
export function hiddenSecretGate(toolName: string, input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  // The service tool's ad-hoc start command is a shell command too.
  if (toolName === "bash" || toolName === "powershell" || toolName === "service") return hasMarker(input.command) ? NOT_RUN_REASON : undefined;
  if (toolName === "edit" || toolName === "write") return hasMarker(input) ? NOT_WRITTEN_REASON : undefined;
  // An lsp rename writes its new name into files.
  if (toolName === "lsp" && input.operation === "rename") return hasMarker(input.newName) ? NOT_WRITTEN_REASON : undefined;
  return undefined;
}
