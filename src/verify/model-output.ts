import path from "node:path";
import { casperAgentDir } from "../runtime/agent-store";
import { loginFileValues, scrubPlainSecrets } from "../secrets/files";
import { scrubText, scrubValue } from "../secrets/scrub";
import type { VerificationResult } from "./evidence";
import { isBuiltinCheck } from "./named";

/**
 * What the model sees of a check (casper_check replies and repair prompts). Every check's output and reason
 * gets the same always-on pass as native bash output: secret-named environment values, Casper's login keys,
 * secret KEY=VALUE lines, address passwords and private keys. Named checks read device configs and playbooks,
 * so they also get the device config rules. The evidence Casper keeps is never changed.
 */
export function checkResultForModel(result: VerificationResult, env: NodeJS.ProcessEnv = process.env): VerificationResult {
  const values = loginFileValues(path.join(casperAgentDir(), "auth.json"));
  const named = !isBuiltinCheck(result.name);
  const hide = (text: string) => scrubPlainSecrets(named ? scrubText(text).text : text, { env, values }).text;
  return { ...result, stdout: hide(result.stdout), stderr: hide(result.stderr), ...(result.reason ? { reason: hide(result.reason) } : {}) };
}

/** Any other evidence the model reads (smoke replies, crash logs, page text): every string gets the same pass. */
export function evidenceForModel<T>(value: T, env: NodeJS.ProcessEnv = process.env): T {
  const values = loginFileValues(path.join(casperAgentDir(), "auth.json"));
  return scrubValue(value, (text) => scrubPlainSecrets(text, { env, values })).value;
}
