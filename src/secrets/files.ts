import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { isSecretName, scrubAssignments, scrubExactValues, scrubUrlPasswords } from "./assignments";
import { KIND_ORDER, keepLiterally, PEM_BEGIN, PEM_END, type SecretKind } from "./patterns";
import { scrubProseSecrets } from "./prose";
import { SECRET_MARKER, scrubText, snakeKey, type ScrubTextResult } from "./scrub";
import { typedSecretValues } from "./typed";

export { isSecretName, scrubAssignments, scrubExactValues, scrubUrlPasswords };

/**
 * Secrets outside device configs: .env, INI and credential files, secret-named KEY=VALUE lines in
 * command and grep output, and the exact values of secret-named environment variables. These run
 * with Casper's own rules only (no netconan) and stay on even with /secrets files off.
 */

/** File names whose values are secrets by default: dotenv, INI, credential and key files. */
const SECRET_FILE_NAME = /^(?:\.env(?:\..*)?|.*\.env|\.envrc|\.netrc|_netrc|\.pgpass|pgpass\.conf|\.npmrc|\.yarnrc(?:\.yml)?|\.pypirc|\.git-credentials|\.dockercfg|\.s3cfg|\.boto|credentials(?:\..*)?|.*[._-]credentials(?:\..*)?|secrets?(?:\..*)?|\.secrets?(?:\..*)?|.*\.(?:ini|properties|tfvars|tfstate|tfstate\.backup|pem|key|ovpn)|id_(?:rsa|dsa|ecdsa|ed25519)|vault[._-]?pass(?:word)?(?:\..*)?)$/i;

/** True for .env, .env.local, prod.env, .envrc, .netrc, credentials, *.ini, *.tfvars, *.pem, id_rsa ... */
export function isSecretFile(filePath: string): boolean {
  const normal = filePath.replaceAll("\\", "/");
  // Docker's login file: ~/.docker/config.json, or a DOCKER_CONFIG folder named docker.
  return SECRET_FILE_NAME.test(path.posix.basename(normal)) || /(?:^|\/)\.?docker\/config\.json$/i.test(normal);
}

/** Key files (*.pem, *.key, *.p8, id_rsa, id_ed25519_deploy ...): a run of long base64 lines in them is a key's body, even with no BEGIN line. */
export function isKeyFile(filePath: string): boolean {
  return /(?:\.(?:pem|key|p8)|^id_(?:rsa|dsa|ecdsa|ed25519)(?:[_-][^.]*)?)$/i.test(path.posix.basename(filePath.replaceAll("\\", "/")));
}

/** PostgreSQL's password file (host:port:database:user:password per line). */
export function isPgpassFile(filePath: string): boolean {
  return /^(?:\.pgpass|pgpass\.conf)$/i.test(path.posix.basename(filePath.replaceAll("\\", "/")));
}

/** The password field of each .pgpass line (the part after the fourth unescaped colon); the rest stays. */
function scrubPgpass(text: string): ScrubTextResult {
  let hidden = 0;
  const lines = text.split("\n").map((line) => {
    if (/^\s*#/.test(line) || !line.trim()) return line;
    let colons = 0;
    for (let at = 0; at < line.length; at++) {
      if (line[at] === "\\") { at++; continue; }
      if (line[at] === ":" && ++colons === 4) {
        const carriage = line.endsWith("\r");
        const value = line.slice(at + 1, carriage ? -1 : undefined);
        if (!value || keepLiterally(value)) return line;
        hidden++;
        return `${line.slice(0, at + 1)}${SECRET_MARKER}${carriage ? "\r" : ""}`;
      }
    }
    return line;
  });
  return { text: hidden ? lines.join("\n") : text, hidden, kinds: hidden ? ["password"] : [] };
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
  // A product's login, or (under "central_logins") a named Central login one level further in.
  const walk = (login: unknown, depth: number) => {
    if (!login || typeof login !== "object" || Array.isArray(login)) return;
    for (const [name, value] of Object.entries(login)) {
      if (typeof value === "string" && value.length >= 4 && /(?:TOKEN|SECRET|CLIENT_ID)$/.test(name)) values.add(value);
      else if (depth < 1) walk(value, depth + 1);
    }
  };
  for (const product of Object.values(data)) walk(product, 0);
  return [...values].sort((a, b) => b.length - a.length);
}

export interface PlainScrubOptions {
  /** The text is a .env, INI or credential file: every secret-named value goes. */
  secretFile?: boolean;
  /** The text is from a key file (*.pem, *.key, id_rsa): a key's body goes even without its BEGIN line. */
  keyFile?: boolean;
  /** The text is a .pgpass file: each line's password goes. */
  pgpass?: boolean;
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
  const exact = [...new Set([...secretEnvValues(options.env), ...(options.values ?? []), ...typedSecretValues()])].sort((a, b) => b.length - a.length);
  add(scrubExactValues(out, exact));
  // Private keys are hidden in any output, with or without the device config rules.
  if (options.secretFile || PEM_BEGIN.test(out) || PEM_END.test(out)) add(scrubText(out, { keyFile: options.keyFile === true }));
  else if (options.keyFile) add(scrubText(out, { keyFile: true, keysOnly: true }));
  if (options.pgpass) add(scrubPgpass(out));
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

/**
 * Whether a write or edit adds a secret to a file: the lines of `after` that `before` did not have (blanks around
 * them ignored), read with the same always-on rules as a command. A .env, credential or key file is where secrets
 * belong, so a secret written there is not one to mention.
 */
export function addsSecret(filePath: string, before: string, after: string, env?: NodeJS.ProcessEnv): SecretFinding | undefined {
  if (isSecretFile(filePath)) return undefined;
  const old = new Map<string, number>();
  for (const line of before.split(/\r?\n/)) old.set(line.trim(), (old.get(line.trim()) ?? 0) + 1);
  const added: Array<{ line: string; at: number }> = [];
  after.split(/\r?\n/).forEach((line, index) => {
    const left = old.get(line.trim()) ?? 0;
    if (left) old.set(line.trim(), left - 1);
    else if (line.trim() !== "") added.push({ line, at: index + 1 });
  });
  if (!added.length) return undefined;
  const found = realSecrets(added.map((entry) => entry.line).join("\n"), { env, testFile: isTestFile(filePath) })[0];
  return found && { ...found, line: added[found.line - 1]!.at };
}

/** A real secret Casper found, said without its value: the line it is on (1-based) and what kind it is. */
export interface SecretFinding { line: number; kind: string }

/** Tests and their fixtures: their tokens and passwords are made up for the test. */
export function isTestFile(filePath: string): boolean {
  const normal = filePath.replaceAll("\\", "/");
  return /(?:^|\/)(?:tests?|__tests__|spec|specs|fixtures?|testdata|__mocks__)\//i.test(normal)
    || /(?:^|\/)(?:test_[^/]*|[^/]*_test\.[^/.]+|[^/]*\.(?:test|spec)\.[^/]+|conftest\.py)$/i.test(normal);
}

/** Words a made-up value is built from: your-api-token-here, <token>, fake_password, changeme. */
const PLACEHOLDER = /your|example|sample|placeholder|changeme|change[-_]me|dummy|fake|mock|test|demo|redacted|replace|insert|xxxx|\*\*\*|\.\.\.|[<>{}]/i;
/** The shapes providers give their keys: GitHub, OpenAI and Anthropic, Stripe, Slack, AWS, GitLab, Google, a JWT. */
const KEY_PREFIX = /^(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|sk-[A-Za-z0-9_-]{20,}|sk_live_\w{16,}|rk_live_\w{16,}|xox[abprs]-[\w-]{10,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|glpat-[\w-]{20,}|AIza[\w-]{30,}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,})$/;
const UUID_VALUE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A name made of words, not a generated value: snake_case (`test_null_origin_is_allowed_only_with_csrf`, `test_0_saves`),
 * CamelCase (`TestNullOriginIsAllowed2`), and dotted paths of them (`self.client.post_form`). */
function identifier(value: string): boolean {
  const word = (part: string) => /^[A-Za-z]{3,}$/.test(part);
  const named = (name: string): boolean => {
    if (/^_*[A-Za-z][A-Za-z0-9]*(?:_+[A-Za-z0-9]+)+_*$/.test(name)) {
      const parts = name.split("_").filter(Boolean);
      return parts.every((part) => /^[A-Za-z]+$/.test(part) || /^\d+$/.test(part)) && parts.filter(word).length >= 2;
    }
    // CamelCase: every hump a word, digits only at a hump's end.
    const humps = name.split(/(?=[A-Z])/);
    return /^[A-Za-z][A-Za-z0-9]*$/.test(name) && humps.every((hump) => /^[A-Z]?[a-z]+\d*$/.test(hump)) && humps.filter((hump) => /[a-z]{3,}/.test(hump)).length >= 2;
  };
  return value.split(".").every((part) => part !== "" && (named(part) || /^[A-Za-z_]\w*$/.test(part) && !/\d/.test(part)));
}

/** Whether a value the rules hid looks like a real credential, not a word, a name, a placeholder or a made-up test value. */
export function credentialShaped(value: string): boolean {
  if (KEY_PREFIX.test(value)) return !/x{6,}|0{8,}/i.test(value);
  if (/\s/.test(value) || value.length < 12 || PLACEHOLDER.test(value) || /^(.)\1+$/.test(value) || identifier(value)) return false;
  if (UUID_VALUE.test(value) || /^[A-Fa-f0-9]{24,}$/.test(value)) return true;
  const digits = value.match(/\d/g)?.length ?? 0;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length;
  return digits >= 2 && classes >= 3;
}

/** The values `scrubPlainSecrets` hid in one line, in order, or undefined when they can't be lined up. */
function hiddenIn(line: string, scrubbed: string): string[] | undefined {
  const pieces = scrubbed.split(SECRET_MARKER);
  const pattern = new RegExp(`^${pieces.map((piece) => piece.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("(.+?)")}$`, "s");
  const match = pattern.exec(line);
  return match ? match.slice(1) : undefined;
}

const KIND_WORDS: Record<SecretKind, string> = { password: "a password", hash: "a password hash", key: "a token or key", psk: "a pre-shared key",
  community: "an SNMP community", "private-key": "a private key" };

/**
 * The real secrets in `text`, each as its line and kind, never its value. The rules that hide secrets read any value
 * behind a secret name (`token = "fake-token-123"`, `--token YOUR_TOKEN`, `**Token:** the one from the dashboard`): hiding
 * those costs nothing, but telling you to change a secret for them trains you to skip the warning that matters. Here a
 * value counts only when it is a secret Casper knows (your environment's, one you typed), a private key, or credential
 * shaped (credentialShaped). In a test file only a secret Casper knows counts: its keys and passwords are made up.
 */
export function realSecrets(text: string, options: { env?: NodeJS.ProcessEnv; testFile?: boolean } = {}): SecretFinding[] {
  const env = secretEnvValues(options.env);
  const typed = typedSecretValues();
  const found: SecretFinding[] = [];
  text.split("\n").forEach((line, index) => {
    const result = scrubPlainSecrets(line, options.env ? { env: options.env } : {});
    if (!result.hidden) return;
    const values = hiddenIn(line, result.text) ?? [];
    const known = values.find((value) => env.includes(value) || typed.includes(value));
    if (known) { found.push({ line: index + 1, kind: env.includes(known) ? "a secret from your environment" : "a secret you typed" }); return; }
    if (options.testFile) return;
    if (result.kinds.includes("private-key")) { found.push({ line: index + 1, kind: KIND_WORDS["private-key"] }); return; }
    // A value may carry its name along (PVEAPIToken=root@pam!app=<uuid>): any part of it may be the credential.
    if (values.some((value) => credentialShaped(value) || value.split(/[=:!@,;"'\s]+/).some(credentialShaped))) found.push({ line: index + 1, kind: KIND_WORDS[result.kinds[0] ?? "key"] });
  });
  // A private key's body spans lines: its BEGIN line alone is enough.
  if (!options.testFile && !found.length && PEM_BEGIN.test(text) && /PRIVATE KEY/.test(text)) {
    const at = text.split("\n").findIndex((line) => /BEGIN [A-Z ]*PRIVATE KEY/.test(line));
    if (at >= 0) found.push({ line: at + 1, kind: KIND_WORDS["private-key"] });
  }
  return found;
}
