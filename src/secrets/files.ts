import path from "node:path";
import { KIND_ORDER, keepLiterally, type SecretKind } from "./patterns";
import { SECRET_MARKER, scrubText, snakeKey, type ScrubTextResult } from "./scrub";

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

/** Name parts that mean "the value is a secret". */
const SECRET_PARTS = new Set(["password", "passwd", "passphrase", "pwd", "pass", "secret", "secrets", "token", "apikey", "psk",
  "credential", "credentials", "bearer", "community", "privatekey", "accesskey", "secretkey", "authkey", "sessionkey", "signingkey"]);
/** Two-part names: api_key, access_key, private_key, client_secret ... */
const SECRET_PAIRS = /(?:^|_)(?:api|access|private|priv|secret|auth|session|signing|encryption|master|shared|pre_shared|client|app|account|service|webhook|consumer)_(?:key|secret|token)(?:_|$)/;
/** A last name part that says the value is not the secret itself. */
const NOT_SECRET_LAST = new Set(["url", "uri", "file", "path", "dir", "host", "hostname", "port", "endpoint", "expiry", "expires", "expiration",
  "ttl", "type", "name", "id", "length", "len", "count", "enabled", "enable", "header", "prefix", "policy", "required", "min", "max", "env",
  "var", "field", "label", "hint", "prompt", "rotation", "format", "help", "location", "region", "mode", "version", "at", "limit", "size",
  "timeout", "user", "username", "cmd", "command", "helper", "method", "scope", "scopes", "audience", "issuer"]);
/** Paging and usage words that end in "token" but are not logins. */
const NOT_SECRET_ANY = /(?:^|_)(?:next|page|continuation|pagination|cursor|sync|resume|start|continue|max|input|output|total|csrf_field|num)(?:_|$)/;

/** Whether a KEY=VALUE, key: value or "key": "value" name looks like it holds a secret. */
export function isSecretName(name: string): boolean {
  const key = snakeKey(name);
  const parts = key.split("_").filter(Boolean);
  // The shell's working folder, not a password.
  if (!parts.length || key === "pwd" || key === "oldpwd") return false;
  if (NOT_SECRET_LAST.has(parts.at(-1)!) || NOT_SECRET_ANY.test(key)) return false;
  if (parts.some((part) => SECRET_PARTS.has(part))) return true;
  if (SECRET_PAIRS.test(key)) return true;
  // Glued names: MIST_APITOKEN, dbpassword, clientsecret.
  return parts.some((part) => /(?:token|secret|password|passwd|passphrase|apikey)$/.test(part));
}

/** Words that are code or types, never a secret value, in command and grep output. */
const CODE_WORDS = new Set(["str", "string", "int", "bool", "boolean", "number", "bytes", "none", "null", "nil", "true", "false", "undefined",
  "any", "unknown", "object", "optional", "required", "self", "this", "secret", "password", "token", "changeme", "example", "xxx", "redacted"]);

function kindFor(name: string): SecretKind {
  const key = snakeKey(name);
  if (/community/.test(key)) return "community";
  if (/psk|passphrase/.test(key)) return "psk";
  if (/pass|pwd/.test(key)) return "password";
  return "key";
}

/** Is this unquoted value a literal (a real value), not code? Only asked for command output. */
function literalValue(value: string, name: string, separator: string): boolean {
  if (value.length < 4 || /[\s(){}[\]<>`]/.test(value) || /^[$%&@*]/.test(value)) return false;
  if (CODE_WORDS.has(value.toLowerCase())) return false;
  // self.password, config.token, os.environ...
  if (/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(value)) return false;
  // A bare identifier is a variable in code; it counts only in dotenv style (NAME=value, name upper case).
  if (/^[A-Za-z_]+$/.test(value)) return separator === "=" && /^[A-Z0-9_]+$/.test(name);
  return true;
}

const ASSIGNMENT = /(^|[^\w.-])(["']?)([A-Za-z_][\w.-]*)\2(\s*)([=:])(\s*)("(?:[^"\\\n]|\\.)*"|'[^'\n]*'|[^\s"'][^\n]*)?/dg;
const AUTH_HEADER = /\b(?:Bearer|Basic|Token)\s+([A-Za-z0-9._~+/-]{8,}=*)/dg;

interface Span { start: number; end: number; kind: SecretKind }

function assignmentSpans(line: string, strict: boolean): Span[] {
  const spans: Span[] = [];
  ASSIGNMENT.lastIndex = 0;
  for (let match = ASSIGNMENT.exec(line); match; match = ASSIGNMENT.exec(line)) {
    const name = match[3]!;
    const raw = match[7];
    const indices = match.indices?.[7];
    // Look for more pairs after this separator: "a=1, TOKEN=x" has two.
    ASSIGNMENT.lastIndex = match.indices![5]![1];
    if (!raw || !indices || !isSecretName(name)) continue;
    // "a == b" and "a := b" are comparisons or code, not stored values.
    if (line[indices[0]] === "=" || (match[5] === ":" && line[match.indices![5]![1]] === "=")) continue;
    let [start, end] = indices;
    let value = raw;
    const quoted = value.length >= 2 && (value[0] === "\"" || value[0] === "'") && value.at(-1) === value[0];
    if (quoted) { start++; end--; value = value.slice(1, -1); }
    else {
      // Unquoted: stop at a comment, a list separator or trailing space.
      const cut = value.search(/\s+#|\s*[,;]\s*(?:$|["'\w])|\s+$/);
      if (cut >= 0) { end = start + cut; value = value.slice(0, cut); }
      // Command output: a value runs to the first space.
      if (!strict) { const space = value.search(/\s/); if (space >= 0) { end = start + space; value = value.slice(0, space); } }
    }
    if (!value || keepLiterally(value) || value.includes(SECRET_MARKER)) continue;
    if (!strict && (quoted ? /\$\{|\{\{|^\s*$/.test(value) || value.length < 4 || CODE_WORDS.has(value.toLowerCase()) : !literalValue(value, name, match[5]!))) continue;
    // In a secret file, a ${VAR} reference is not a value.
    if (strict && /^\$\{?[A-Za-z_]\w*\}?$/.test(value)) continue;
    spans.push({ start, end, kind: kindFor(name) });
    ASSIGNMENT.lastIndex = Math.max(ASSIGNMENT.lastIndex, end);
  }
  AUTH_HEADER.lastIndex = 0;
  for (let match = AUTH_HEADER.exec(line); match; match = AUTH_HEADER.exec(line)) {
    const [start, end] = match.indices![1]!;
    if (!keepLiterally(match[1]!)) spans.push({ start, end, kind: "key" });
  }
  return spans;
}

function applySpans(line: string, spans: Span[], kinds: Set<SecretKind>): { line: string; hidden: number } {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Span[] = [];
  for (const span of sorted) {
    const last = merged.at(-1);
    if (last && span.start < last.end) { last.end = Math.max(last.end, span.end); continue; }
    merged.push({ ...span });
  }
  let next = line;
  for (const span of merged.reverse()) {
    next = next.slice(0, span.start) + SECRET_MARKER + next.slice(span.end);
    kinds.add(span.kind);
  }
  return { line: next, hidden: merged.length };
}

/**
 * Hide values of secret-named keys: MIST_APITOKEN=abc123, password = x, "client_secret": "y",
 * api_key: z, and Authorization: Bearer tokens. `strict` (a .env or credential file) hides every
 * value of such a key; otherwise (command and grep output) only values that look like literals, so
 * `token = getToken()` in grepped code stays as it is.
 */
export function scrubAssignments(text: string, strict: boolean): ScrubTextResult {
  const lines = text.split("\n");
  const kinds = new Set<SecretKind>();
  let hidden = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const spans = assignmentSpans(line, strict);
    if (!spans.length) continue;
    const result = applySpans(line, spans, kinds);
    lines[index] = result.line;
    hidden += result.hidden;
  }
  return { text: hidden ? lines.join("\n") : text, hidden, kinds: KIND_ORDER.filter((kind) => kinds.has(kind)) };
}

/** Environment names that hold credentials (matches the MCP check's list). */
const SECRET_ENV_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|CLIENT_SECRET|BEARER|CREDENTIAL)/i;

/**
 * The values of Casper's own secret-named environment variables (provider keys, MIST_API_TOKEN,
 * CENTRAL_CLIENT_SECRET ...), longest first. Short values, paths and URLs are left out: hiding
 * them everywhere would hide ordinary text.
 */
export function secretEnvValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < 8 || !(SECRET_ENV_NAME.test(name) || isSecretName(name))) continue;
    if (/^(?:\/|~|[A-Za-z]:[\\/]|\.{1,2}[\\/])/.test(value) || /^[a-z][\w+.-]*:\/\/[^@]*$/i.test(value)) continue;
    if (/^\d+$/.test(value) || /^(?:true|false|yes|no|on|off)$/i.test(value) || keepLiterally(value)) continue;
    values.add(value);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

/** Hide every exact copy of the given values (for example `printenv OPENROUTER_API_KEY`). */
export function scrubExactValues(text: string, values: readonly string[]): ScrubTextResult {
  let out = text;
  let hidden = 0;
  for (const value of values) {
    if (!out.includes(value)) continue;
    const parts = out.split(value);
    hidden += parts.length - 1;
    out = parts.join(SECRET_MARKER);
  }
  return { text: out, hidden, kinds: hidden ? ["key"] : [] };
}

export interface PlainScrubOptions {
  /** The text is a .env, INI or credential file: every secret-named value goes. */
  secretFile?: boolean;
  env?: NodeJS.ProcessEnv;
}

/** The always-on pass for native read, grep and shell output: env values, secret-named keys, and in a
 * secret file also private keys and the device rules. */
export function scrubPlainSecrets(text: string, options: PlainScrubOptions = {}): ScrubTextResult {
  const kinds = new Set<SecretKind>();
  let hidden = 0;
  let out = text;
  const add = (result: ScrubTextResult) => { out = result.text; hidden += result.hidden; for (const kind of result.kinds) kinds.add(kind); };
  add(scrubExactValues(out, secretEnvValues(options.env)));
  if (options.secretFile) add(scrubText(out));
  add(scrubAssignments(out, options.secretFile === true));
  return { text: out, hidden, kinds: KIND_ORDER.filter((kind) => kinds.has(kind)) };
}
