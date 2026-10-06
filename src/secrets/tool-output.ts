import { scrubNote, type Scrubber } from "./netconan";
import { KIND_ORDER, type SecretKind } from "./patterns";
import path from "node:path";
import { isKeyFile, isPgpassFile, isSecretFile, loginFileValues, networkLoginValues, scrubPlainSecrets } from "./files";
import { casperAgentDir } from "../runtime/agent-store";
import { scrubText, shouldScrubCommandOutput, shouldScrubRead, type ScrubTextResult } from "./scrub";

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
  /** Casper's login file, whose keys are hidden wherever they show up; defaults to <agent dir>/auth.json. */
  loginFile?: string;
  /** Casper's network login file (~/.casper/network-logins.json), whose tokens are hidden too. */
  networkLoginFile?: string;
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
  let keyFile = false;
  let pgpass = false;
  if (toolName === "read") {
    if (typeof input.path !== "string") return undefined;
    secretFile = isSecretFile(input.path);
    keyFile = isKeyFile(input.path);
    pgpass = isPgpassFile(input.path);
    device = configs && (shouldScrubRead(input.path) || (isSavedCommandOutput(input.path) && shouldScrubCommandOutput(texts.join("\n"))));
  } else if (["bash", "powershell", "grep", "service", "browser"].includes(toolName)) {
    // service: a dev server's logs, crash tails and HTTP replies are command output too; browser: a page's text.
    device = configs && shouldScrubCommandOutput(texts.join("\n"));
  } else if (toolName === "lsp") {
    // A language server's messages quote source (TypeScript puts literal types in them): the always-on pass only.
    device = false;
  } else return undefined;
  let hidden = 0;
  let failed = false;
  const kinds = new Set<SecretKind>();
  const out: string[] = [];
  const values = [...loginFileValues(options.loginFile ?? path.join(casperAgentDir(), "auth.json")),
    ...options.networkLoginFile ? networkLoginValues(options.networkLoginFile) : []];
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
    const plainOptions = { secretFile, keyFile, pgpass, values, ...(options.env ? { env: options.env } : {}) };
    // The service, browser and lsp tools answer in JSON: check each string as it reads, not with its \n escapes.
    const plain = ["service", "browser", "lsp"].includes(toolName) ? scrubJsonStrings(next, (value) => scrubPlainSecrets(value, plainOptions)) : scrubPlainSecrets(next, plainOptions);
    hidden += plain.hidden;
    for (const kind of plain.kinds) kinds.add(kind);
    out.push(plain.text);
  }
  if (!hidden && !failed) return undefined;
  const note = scrubNote({ hidden, kinds: KIND_ORDER.filter((kind) => kinds.has(kind)), ...(failed ? { netconan: "failed" } : {}) });
  return { texts: out, ...(note ? { note } : {}) };
}

/** Scrub every string inside a JSON text; text that isn't JSON is scrubbed as it is. */
function scrubJsonStrings(text: string, scrub: (value: string) => ScrubTextResult): ScrubTextResult {
  let data: unknown;
  try { data = JSON.parse(text); } catch { return scrub(text); }
  let hidden = 0;
  const kinds = new Set<SecretKind>();
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      const result = scrub(value);
      hidden += result.hidden;
      for (const kind of result.kinds) kinds.add(kind);
      return result.text;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, walk(inner)]));
    return value;
  };
  const next = walk(data);
  return { text: hidden ? JSON.stringify(next) : text, hidden, kinds: KIND_ORDER.filter((kind) => kinds.has(kind)) };
}
