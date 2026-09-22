import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Native edit/write paths are literal filesystem paths, not tool-input syntax. `pattern` (grep/find)
 * and `check` (casper_check) are identities shown in tool activity; never an edit body or an
 * arbitrary argument. */
export interface ToolObservationInput { path?: string; command?: string; operation?: string; pattern?: string; check?: string }

/** Pi 0.85.1's native edit/write path syntax (its resolver is not an SDK export).
 * Expand once at the adapter boundary; the result is a literal filesystem path. */
export function nativeEditPath(input: string): string | undefined {
  const file = input.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ").replace(/^@/, "");
  if (file === "~") return homedir();
  if (file.startsWith("~/") || (process.platform === "win32" && file.startsWith("~\\"))) return path.join(homedir(), file.slice(2));
  try { return file.startsWith("file://") ? fileURLToPath(file) : file; }
  catch { return undefined; } // Pi rejects an invalid file URL before any write.
}
export interface ToolObservationOutput { text: string; truncated: boolean }

/** Only identity fields, never edit bodies, credentials or arbitrary tool arguments. */
export function observationInput(value: unknown): ToolObservationInput {
  if (typeof value !== "object" || value === null) return {};
  const result: ToolObservationInput = {};
  for (const key of ["path", "command", "operation", "pattern", "check"] as const) {
    const field = Reflect.get(value, key);
    // Omit oversized identities: truncating could match a different command/path.
    if (typeof field === "string" && Buffer.byteLength(field) <= 8192) result[key] = field;
  }
  return result;
}

export function boundObservationText(text: string): ToolObservationOutput {
  const limit = 8192;
  if (Buffer.byteLength(text) <= limit) return { text, truncated: false };
  const head = Buffer.from(text.slice(0, 4096));
  let end = Math.min(4000, head.length);
  while (end && (head[end]! & 0xc0) === 0x80) end--;
  const tail = Buffer.from(text.slice(-4096));
  let start = Math.max(0, tail.length - 4000);
  while (start < tail.length && (tail[start]! & 0xc0) === 0x80) start++;
  return { text: `${head.subarray(0, end).toString("utf8")}\n[...output truncated...]\n${tail.subarray(start).toString("utf8")}`, truncated: true };
}

/** Pi's result envelope is diagnostic data; it supplies no trustworthy exit code. */
export function observationOutput(value: unknown): ToolObservationOutput {
  if (typeof value !== "object" || value === null) return { text: "", truncated: false };
  const content: unknown = Reflect.get(value, "content");
  if (!Array.isArray(content)) return { text: "", truncated: false };
  const details: unknown = Reflect.get(value, "details");
  let truncated = content.length > 32;
  if (typeof details === "object" && details !== null && Reflect.get(details, "truncation")) truncated = true;
  let text = "";
  for (const part of content.slice(0, 32)) {
    if (typeof part !== "object" || part === null || Reflect.get(part, "type") !== "text") continue;
    const field: unknown = Reflect.get(part, "text");
    if (typeof field !== "string") continue;
    const bounded = boundObservationText(field);
    const combined = boundObservationText(text ? `${text}\n${bounded.text}` : bounded.text);
    text = combined.text;
    truncated ||= bounded.truncated || combined.truncated;
  }
  return { text, truncated };
}
