import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { isSecretName, scrubAssignments, scrubExactValues, scrubUrlPasswords } from "./assignments";
import { KIND_ORDER, keepLiterally, PEM_BEGIN, type SecretKind } from "./patterns";
import { scrubProseSecrets } from "./prose";
import { scrubText, snakeKey, type ScrubTextResult } from "./scrub";

export { isSecretName, scrubAssignments, scrubExactValues, scrubUrlPasswords };

/**
 * Secrets outside device configs: .env, INI and credential files, secret-named KEY=VALUE lines in
 * command and grep output, and the exact values of secret-named environment variables. These run
 * with Casper's own rules only (no netconan) and stay on even with /secrets files off.
 */

/** File names whose values are secrets by default: dotenv, INI, credential and key files. */
const SECRET_FILE_NAME = /^(?:\.env(?:\..*)?|.*\.env|\.envrc|\.netrc|_netrc|\.pgpass|\.npmrc|\.yarnrc(?:\.yml)?|\.pypirc|\.git-credentials|\.dockercfg|\.s3cfg|\.boto|credentials(?:\..*)?|.*[._-]credentials(?:\..*)?|secrets?(?:\..*)?|\.secrets?(?:\..*)?|.*\.(?:ini|properties|tfvars|tfstate|tfstate\.backup|pem|key|ovpn)|id_(?:rsa|dsa|ecdsa|ed25519)|vault[._-]?pass(?:word)?(?:\..*)?)$/i;

/** True for .env, .env.local, prod.env, .envrc, .netrc, credentials, *.ini, *.tfvars, *.pem, id_rsa ... */
export function isSecretFile(filePath: string): boolean {
  return SECRET_FILE_NAME.test(path.posix.basename(filePath.replaceAll("\\", "/")));
}

/** Environment names that hold credentials (matches the MCP check's list). */
const SECRET_ENV_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|CLIENT_SECRET|BEARER|CREDENTIAL)/i;
/** Names whose URL value is the login: SLACK_WEBHOOK_URL, TEAMS_WEBHOOK, SENTRY_DSN. */
const WEBHOOK_OR_DSN = /(?:^|_)(?:webhook|dsn)(?:_|$)/;

/** A plain address on this machine (localhost, *.localhost, 127.x, ::1): a dev webhook or database, not a login. */
function onThisMachine(value: string): boolean {
  let host: string;
  try { host = new URL(value).hostname.toLowerCase(); } catch { return false; }
  return host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * The values of Casper's own secret-named environment variables (provider keys, MIST_API_TOKEN,
 * CENTRAL_CLIENT_SECRET ...), longest first. Short values, paths and URLs are left out: hiding
 * them everywhere would hide ordinary text. Webhook and DSN addresses (SLACK_WEBHOOK_URL, SENTRY_DSN)
 * are the login itself, so those stay in, unless they point at this machine (localhost, 127.x, ::1).
 */
export function secretEnvValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < 8 || !(SECRET_ENV_NAME.test(name) || isSecretName(name))) continue;
    if (/^(?:\/|~|[A-Za-z]:[\\/]|\.{1,2}[\\/])/.test(value)) continue;
    // A webhook or DSN address is itself the login, so it stays on the list; other plain URLs don't.
    if (/^[a-z][\w+.-]*:\/\/[^@]*$/i.test(value) && (!WEBHOOK_OR_DSN.test(snakeKey(name)) || onThisMachine(value))) continue;
    if (/^\d+$/.test(value) || /^(?:true|false|yes|no|on|off)$/i.test(value) || keepLiterally(value)) continue;
    values.add(value);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

/**
 * The keys and sign-in tokens in Casper's login file (auth.json), so `cat` of it in the AI's shell
 * shows none of them. Short strings (provider names, "api_key") are left out.
 */
export function loginFileValues(file: string): string[] {
  let data: unknown;
  try { if (statSync(file).size > 1024 * 1024) return []; data = JSON.parse(readFileSync(file, "utf8")); } catch { return []; }
  const values: string[] = [];
  const walk = (value: unknown, depth: number) => {
    if (typeof value === "string") { if (value.length >= 16 && !/\s/.test(value)) values.push(value); }
    else if (value && typeof value === "object" && depth < 6) for (const inner of Object.values(value)) walk(inner, depth + 1);
  };
  walk(data, 0);
  return values;
}

/**
 * The logins in Casper's network login file (~/.casper/network-logins.json): every token, secret and client ID,
 * 4 characters or longer (a short one is still a login). Addresses are left out. Read fresh each time, so a
 * login you forget stops being hidden and a new one is hidden at once.
 */
export function networkLoginValues(file: string): string[] {
  let data: unknown;
  try { if (statSync(file).size > 1024 * 1024) return []; data = JSON.parse(readFileSync(file, "utf8")); } catch { return []; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const values = new Set<string>();
  for (const product of Object.values(data)) {
    if (!product || typeof product !== "object" || Array.isArray(product)) continue;
    for (const [name, value] of Object.entries(product)) {
      if (typeof value === "string" && value.length >= 4 && /(?:TOKEN|SECRET|CLIENT_ID)$/.test(name)) values.add(value);
    }
  }
  return [...values].sort((a, b) => b.length - a.length);
}

export interface PlainScrubOptions {
  /** The text is a .env, INI or credential file: every secret-named value goes. */
  secretFile?: boolean;
  env?: NodeJS.ProcessEnv;
  /** More exact values to hide (the keys in Casper's login file). */
  values?: readonly string[];
}

/** The always-on pass for native read, grep and shell output: env values, secret-named keys, and in a
 * secret file also private keys and the device rules. */
export function scrubPlainSecrets(text: string, options: PlainScrubOptions = {}): ScrubTextResult {
  const kinds = new Set<SecretKind>();
  let hidden = 0;
  let out = text;
  const add = (result: ScrubTextResult) => { out = result.text; hidden += result.hidden; for (const kind of result.kinds) kinds.add(kind); };
  const exact = [...new Set([...secretEnvValues(options.env), ...(options.values ?? [])])].sort((a, b) => b.length - a.length);
  add(scrubExactValues(out, exact));
  // Private keys are hidden in any output, with or without the device config rules.
  if (options.secretFile || PEM_BEGIN.test(out)) add(scrubText(out));
  add(scrubUrlPasswords(out));
  add(scrubAssignments(out, options.secretFile === true));
  add(scrubProseSecrets(out));
  return { text: out, hidden, kinds: KIND_ORDER.filter((kind) => kinds.has(kind)) };
}

/**
 * A command the AI sent (bash, powershell), before Casper shows or keeps it: the same always-on rules as tool output,
 * so a password or token the AI typed into a command is hidden on screen, in records and on the receipt. The AI
 * already has it; `hidden` > 0 means the receipt says to change it.
 */
export function hideCommandSecrets(command: string, env?: NodeJS.ProcessEnv): ScrubTextResult {
  return scrubPlainSecrets(command, env ? { env } : {});
}
