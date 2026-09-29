import { scrubNote, type Scrubber } from "./netconan";
import { KIND_ORDER, type SecretKind } from "./patterns";
import { scrubText, shouldScrubCommandOutput, shouldScrubRead } from "./scrub";

/**
 * Native tool output the model is about to read. Config files (.cfg, .conf, .set, or under
 * configs/backups/oxidized) and command or grep output that looks like a device config get their
 * secrets hidden. Source code is never changed. Undefined means "leave the result as it is".
 */
export async function scrubToolOutput(scrubber: Pick<Scrubber, "scrubText">, toolName: string, input: Record<string, unknown>,
  texts: string[], signal?: AbortSignal): Promise<{ texts: string[]; note?: string } | undefined> {
  if (toolName === "read") {
    if (typeof input.path !== "string" || !shouldScrubRead(input.path)) return undefined;
  } else if (["bash", "powershell", "grep"].includes(toolName)) {
    if (!shouldScrubCommandOutput(texts.join("\n"))) return undefined;
  } else return undefined;
  let hidden = 0;
  let failed = false;
  const kinds = new Set<SecretKind>();
  const out: string[] = [];
  for (const text of texts) {
    // A netconan problem (or an abort while it runs) falls back to Casper's own rules.
    const result = await scrubber.scrubText(text, signal).catch(() => ({ ...scrubText(text), netconan: "failed" as const }));
    hidden += result.hidden;
    failed ||= result.netconan === "failed";
    for (const kind of result.kinds) kinds.add(kind);
    out.push(result.text);
  }
  if (!hidden && !failed) return undefined;
  const note = scrubNote({ hidden, kinds: KIND_ORDER.filter((kind) => kinds.has(kind)), ...(failed ? { netconan: "failed" } : {}) });
  return { texts: out, ...(note ? { note } : {}) };
}
