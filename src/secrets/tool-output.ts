import { scrubNote, type Scrubber } from "./netconan";
import { KIND_ORDER, type SecretKind } from "./patterns";
import { isSecretFile, scrubPlainSecrets } from "./files";
import { scrubText, shouldScrubCommandOutput, shouldScrubRead } from "./scrub";

/**
 * Pi keeps the whole output of a long command in <tmp>/pi-bash-<id>.log (or pi-powershell-) and tells
 * the AI that path. Reading it back is command output, so it gets the same config check.
 */
export function isSavedCommandOutput(filePath: string): boolean {
  return /(?:^|[\\/])pi-(?:bash|powershell)-[0-9a-f]+\.log$/i.test(filePath);
}

export interface ToolOutputScrubOptions {
  /** Device-config scrubbing (config files, config-looking output); /secrets files off turns it off. */
  configs?: boolean;
  /** Environment whose secret-named values are hidden; defaults to Casper's own. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Native tool output the model is about to read. Two passes:
 * - Device configs (while /secrets files is on): config files (.cfg, .conf, .set, or under
 *   configs/backups/oxidized) and command or grep output that looks like a device config.
 * - Always: .env, INI and credential files, secret-named KEY=VALUE lines in command and grep output,
 *   and exact copies of Casper's own secret-named environment values.
 * Source code is never changed by the device pass. Undefined means "leave the result as it is".
 */
export async function scrubToolOutput(scrubber: Pick<Scrubber, "scrubText">, toolName: string, input: Record<string, unknown>,
  texts: string[], signal?: AbortSignal, options: ToolOutputScrubOptions = {}): Promise<{ texts: string[]; note?: string } | undefined> {
  const configs = options.configs ?? true;
  let device: boolean;
  let secretFile = false;
  if (toolName === "read") {
    if (typeof input.path !== "string") return undefined;
    secretFile = isSecretFile(input.path);
    device = configs && (shouldScrubRead(input.path) || (isSavedCommandOutput(input.path) && shouldScrubCommandOutput(texts.join("\n"))));
  } else if (["bash", "powershell", "grep"].includes(toolName)) {
    device = configs && shouldScrubCommandOutput(texts.join("\n"));
  } else return undefined;
  let hidden = 0;
  let failed = false;
  const kinds = new Set<SecretKind>();
  const out: string[] = [];
  for (const text of texts) {
    let next = text;
    if (device) {
      // A netconan problem (or an abort while it runs) falls back to Casper's own rules.
      const result = await scrubber.scrubText(text, signal).catch(() => ({ ...scrubText(text), netconan: "failed" as const }));
      hidden += result.hidden;
      failed ||= result.netconan === "failed";
      for (const kind of result.kinds) kinds.add(kind);
      next = result.text;
    }
    const plain = scrubPlainSecrets(next, { secretFile, ...(options.env ? { env: options.env } : {}) });
    hidden += plain.hidden;
    for (const kind of plain.kinds) kinds.add(kind);
    out.push(plain.text);
  }
  if (!hidden && !failed) return undefined;
  const note = scrubNote({ hidden, kinds: KIND_ORDER.filter((kind) => kinds.has(kind)), ...(failed ? { netconan: "failed" } : {}) });
  return { texts: out, ...(note ? { note } : {}) };
}
