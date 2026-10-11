import { scrubPlainSecrets } from "./files";
import { containsHiddenSecret, scrubText } from "./scrub";

/** True when text Casper would send out (a web search, an address, a picture's description) holds a secret: a
 * device secret, a known key shape, a secret-named environment value or one of `values`. %XX runs are read decoded
 * too, each run on its own, so one bad escape elsewhere can't hide an encoded secret. Such text is refused, never
 * sent with the secret cut out. */
export function holdsSecret(text: string, options: { values?: readonly string[]; env?: NodeJS.ProcessEnv } = {}): boolean {
  const decoded = text.replace(/\+/g, " ").replace(/(?:%[0-9a-f]{2})+/gi, (run) => { try { return decodeURIComponent(run); } catch { return run; } });
  const env = options.env ?? process.env;
  for (const candidate of new Set([text, decoded])) {
    if (containsHiddenSecret(candidate) || scrubText(candidate).hidden || scrubPlainSecrets(candidate, { env, values: options.values ?? [] }).hidden) return true;
  }
  return false;
}
