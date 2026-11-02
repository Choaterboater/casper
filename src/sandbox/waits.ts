import { lookCommand } from "../flows/plan";
import { timeoutCommand } from "./read-only";

/**
 * Commands that only wait or look: a `sleep`, a poll loop of sleeps and checks (`while …; do ssh nas 'docker ps';
 * sleep 15; done`), `ssh host sleep 30`, and `timeout` or `perl -e 'alarm N; exec …'` around a read. A line the person
 * sends the AI stops such a command at once (src/runtime/pi.ts), since stopping it loses nothing but the wait.
 * A text check and an allow-list, like read-only.ts: every command on the line, in each loop, `$(…)`, `bash -c` or
 * ssh command, must be a look on Casper's list (src/flows/plan.ts) or one of the checks below, with no output
 * redirect but /dev/null, no background `&`, no here-document, backtick or eval. Anything else may change something,
 * and is never stopped this way.
 */

/** What a line was seen to do: its first sleep, a `while` or `until` loop, a `for` loop, a time-limit wrapper, and a
 * command that follows a log (`tail -f`). */
interface Seen { sleep?: string; loop?: boolean; repeat?: boolean; wrapper?: string; follows?: string }

/** `assigns`: it starts with a plain `NAME=` (an assignment, not a program). */
type Word = { text: string; literal: boolean; assigns?: boolean };
type Token = { op: string } | Word;

const DEPTH = 4;
/** Variables that change what a later program is (PATH) or run code (BASH_ENV): never set on a line that is stopped. */
const RISKY_NAMES = /^(?:PATH|IFS|CDPATH|ENV|BASH_ENV|SHELLOPTS|BASHOPTS|PROMPT_COMMAND|LD_\w+|DYLD_\w+)$/;
const KEYWORDS = new Set(["do", "done", "if", "then", "else", "elif", "fi", "!", "{", "}", "time"]);
const BIN = /^\/(?:usr\/(?:local\/)?|opt\/homebrew\/)?s?bin\/(?=[^/]+$)/;

/** The command's few words for the person ("sleep 15 loop", "sleep 90", "timeout 25") when it only waits and looks;
 * undefined when it may change something, Casper can't read it, or it reads without waiting (`cat log`). */
export function waitLabel(command: string): string | undefined {
  const seen: Seen = {};
  if (!lineLooks(command, seen, 0)) return undefined;
  if (!seen.sleep && !seen.loop && !seen.wrapper && !seen.follows) return undefined;
  if (seen.loop || (seen.repeat && seen.sleep)) return `${seen.sleep ?? "check"} loop`;
  return seen.sleep ?? seen.follows ?? seen.wrapper;
}

/** Every command on the line only waits or looks, here or over ssh: it changes nothing. */
export function onlyLooksOrWaits(command: string): boolean {
  return lineLooks(command, {}, 0);
}

function lineLooks(source: string, seen: Seen, depth: number): boolean {
  if (depth > DEPTH || source.length > 4000) return false;
  const tokens = lex(source, seen, depth);
  if (!tokens) return false;
  let words: Word[] = [];
  for (const token of [...tokens, { op: ";" }]) {
    if ("op" in token) {
      if (!commandLooks(words, seen, depth)) return false;
      words = [];
    } else words.push(token);
  }
  return true;
}

/** The line as words and operators, quotes removed; every `$(…)` in it checked as a line of its own. Undefined for what
 * this check doesn't read: a backtick, a here-document, process substitution, a background `&`, `case`'s `;;`, an
 * unclosed quote, and an output redirect to anything but /dev/null or another stream. */
function lex(s: string, seen: Seen, depth: number): Token[] | undefined {
  const tokens: Token[] = [];
  let word = "", inWord = false, literal = true;
  /** The word's plain start, before any quote, `$` or backslash. */
  let lead = "", plain = true;
  /** An output redirect waits for its target word. */
  let target: "out" | "in" | undefined;
  const end = (): boolean => {
    if (!inWord) return true;
    const text = word, wasLiteral = literal, assigns = /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(lead);
    word = ""; inWord = false; literal = true; lead = ""; plain = true;
    if (target) {
      const ok = target === "in" || (wasLiteral && ["/dev/null", "/dev/stdout", "/dev/stderr"].includes(text));
      target = undefined;
      return ok;
    }
    tokens.push({ text, literal: wasLiteral, ...(assigns ? { assigns } : {}) });
    return true;
  };
  const op = (text: string): boolean => {
    if (!end() || target) return false;
    tokens.push({ op: text });
    return true;
  };
  /** `$…` at `at`: what it stands for in a word, and where reading goes on. */
  const dollar = (at: number): { text: string; next: number } | undefined => {
    const next = s[at + 1];
    if (next === "(" && s[at + 2] === "(") {
      const close = matching(s, at + 1);
      if (close === undefined) return undefined;
      const inner = s.slice(at + 3, close - 1);
      if (/[`]|\$\(/.test(inner)) return undefined;
      return { text: "0", next: close + 1 };
    }
    if (next === "(") {
      const close = matching(s, at + 1);
      if (close === undefined || !lineLooks(s.slice(at + 2, close), seen, depth + 1)) return undefined;
      return { text: "x", next: close + 1 };
    }
    if (next === "{") {
      const close = s.indexOf("}", at + 2);
      if (close < 0 || /[`]|\$\(/.test(s.slice(at + 2, close))) return undefined;
      return { text: "x", next: close + 1 };
    }
    if (next === "'") {
      const close = s.indexOf("'", at + 2);
      return close < 0 ? undefined : { text: s.slice(at + 2, close), next: close + 1 };
    }
    const name = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9#?$!@*-])/.exec(s.slice(at + 1));
    return name ? { text: "x", next: at + 1 + name[0].length } : { text: "$", next: at + 1 };
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === " " || c === "\t") { if (!end()) return undefined; i++; continue; }
    if (c === "\n" || c === "\r") { if (!op(";")) return undefined; i++; continue; }
    if (c === "#" && !inWord) { while (i < s.length && s[i] !== "\n") i++; continue; }
    if (c === "\\") {
      if (s[i + 1] === "\n") { i += 2; continue; }
      word += s[i + 1] ?? ""; inWord = true; plain = false; i += 2; continue;
    }
    if (c === "'") {
      const close = s.indexOf("'", i + 1);
      if (close < 0) return undefined;
      word += s.slice(i + 1, close); inWord = true; plain = false; i = close + 1; continue;
    }
    if (c === "\"") {
      i++; inWord = true; plain = false;
      while (i < s.length && s[i] !== "\"") {
        const d = s[i]!;
        if (d === "`") return undefined;
        if (d === "\\") { word += s[i + 1] ?? ""; i += 2; continue; }
        if (d === "$") {
          const used = dollar(i);
          if (!used) return undefined;
          word += used.text; literal = false; i = used.next; continue;
        }
        word += d; i++;
      }
      if (i >= s.length) return undefined;
      i++; continue;
    }
    if (c === "`") return undefined;
    if (c === "$") {
      const used = dollar(i);
      if (!used) return undefined;
      word += used.text; literal = false; inWord = true; plain = false; i = used.next; continue;
    }
    if (c === "(" && s[i + 1] === "(" && !inWord) {
      // An arithmetic command, `(( n++ ))` or `for ((…))`: it only counts.
      const close = matching(s, i);
      if (close === undefined || /[`]|\$\(/.test(s.slice(i, close))) return undefined;
      if (!end()) return undefined;
      tokens.push({ text: "((", literal: true });
      i = close + 1; continue;
    }
    if (c === "(" || c === ")") { if (!op(c)) return undefined; i++; continue; }
    if (c === ";") { if (s[i + 1] === ";" || !op(";")) return undefined; i++; continue; }
    if (c === "|") {
      const two = s[i + 1] === "|" || s[i + 1] === "&";
      if (!op(s[i + 1] === "|" ? "||" : "|")) return undefined;
      i += two ? 2 : 1; continue;
    }
    if (c === "&" && s[i + 1] === "&") { if (!op("&&")) return undefined; i += 2; continue; }
    if (c === ">" || c === "<" || (c === "&" && s[i + 1] === ">")) {
      // A number just before it is the stream it redirects (2>), not a word.
      if (inWord && literal && /^\d+$/.test(word)) { word = ""; inWord = false; }
      else if (!end()) return undefined;
      if (target) return undefined;
      if (c === "<") {
        if (s[i + 1] === "<" && s[i + 2] !== "<") return undefined;
        if (s[i + 1] === "(") return undefined;
        if (s[i + 1] === "&") { const fd = /^<&(?:\d+|-)/.exec(s.slice(i)); if (!fd) return undefined; i += fd[0].length; continue; }
        i += s[i + 1] === "<" ? 3 : 1;
        target = "in"; continue;
      }
      i += c === "&" ? 2 : 1;
      if (s[i] === ">" || s[i] === "|") i++;
      if (s[i] === "(") return undefined;
      if (s[i] === "&") { const fd = /^&(?:\d+|-)/.exec(s.slice(i)); if (!fd) return undefined; i += fd[0].length; continue; }
      target = "out"; continue;
    }
    if (c === "&") return undefined;
    if (plain) lead += c;
    word += c; inWord = true; i++;
  }
  if (!end() || target) return undefined;
  return tokens;
}

/** Where the bracket opened at `at` closes, past quotes and nested brackets; undefined when it doesn't. */
function matching(s: string, at: number): number | undefined {
  let depth = 0;
  let quote: string | undefined;
  for (let i = at; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === "\\" && quote === "\"") i++;
      else if (c === quote) quote = undefined;
      continue;
    }
    if (c === "\\") { i++; continue; }
    if (c === "'" || c === "\"") { quote = c; continue; }
    if (c === "(") depth++;
    if (c === ")" && --depth === 0) return i;
  }
  return undefined;
}

function commandLooks(tokens: readonly Word[], seen: Seen, depth: number): boolean {
  let at = 0;
  for (; at < tokens.length && tokens[at]!.literal; at++) {
    const word = tokens[at]!.text;
    if (word === "while" || word === "until") { seen.loop = true; continue; }
    if (!KEYWORDS.has(word)) break;
  }
  const rest = tokens.slice(at);
  const first = rest[0];
  if (!first) return true;
  // `for n in 1 2 3`: its words were read (any `$(…)` checked); the body is the next commands.
  if (first.literal && first.text === "for") { seen.repeat = true; return true; }
  if (first.literal && first.text === "((") return rest.length === 1;
  let start = 0;
  for (; start < rest.length && rest[start]!.assigns; start++) if (RISKY_NAMES.test(rest[start]!.text.replace(/\+?=[\s\S]*$/, ""))) return false;
  const words = rest.slice(start);
  if (!words.length) return true;
  if (!words[0]!.literal) return false;
  return wordsLook([words[0]!.text.replace(BIN, ""), ...words.slice(1).map((word) => word.text)], seen, depth);
}

/** One command's words: a look, a wait, or a check that changes nothing. */
function wordsLook(words: readonly string[], seen: Seen, depth: number): boolean {
  const [name = "", ...args] = words;
  switch (name) {
    case "sleep":
      if (!args.length || args.some((arg) => arg.startsWith("-"))) return false;
      seen.sleep ??= `sleep ${args.join(" ")}`;
      return true;
    case "[": case "[[": case "test": case "true": case "false": case ":": case "break": case "continue": case "exit": case "return":
    case "let": case "expr": case "seq": case "set": case "shift": case "unset": case "read": case "wait":
    case "ps": case "pgrep": case "uptime": case "id": case "printenv": case "free": case "vmstat": case "iostat": case "top": case "lsof":
    case "ss": case "netstat": case "dig": case "nslookup": case "host": case "getent": case "ping": case "nproc": case "sw_vers":
      return true;
    case "export": case "local": case "declare": case "typeset": case "readonly":
      return args.every((arg) => arg.startsWith("-") || !RISKY_NAMES.test(arg.split("=")[0]!.replace(/\+$/, "")));
    case "env":
      return args.length === 0;
    case "hostname":
      return args.every((arg) => /^-[sfidaIA]+$/.test(arg));
    case "nc":
      return args.some((arg) => /^-[a-zA-Z]*z/.test(arg)) && !args.some((arg) => /^-[a-zA-Z]*[elc]/.test(arg));
    case "tail":
      if (follows(args)) seen.follows ??= "tail -f";
      return lookCommand(words);
    case "curl": return curlReads(args);
    case "wget": return args.every((arg) => /^(?:-q|-S|--spider|-O-|-O|-|--quiet|--server-response|--timeout=\d+|-T|\d+)$/.test(arg) || /^https?:\/\//.test(arg))
      && (args.includes("--spider") || args.includes("-O-") || args.join(" ").includes("-O -"));
    case "docker": case "podman":
      if (args.includes("logs") && follows(args)) seen.follows ??= `${name} logs -f`;
      return dockerReads(args);
    case "systemctl": return systemctlReads(args);
    case "journalctl":
      if (follows(args)) seen.follows ??= "journalctl -f";
      return !args.some((arg) => /^--(?:vacuum|rotate|flush|sync|setup-keys|update-catalog|relinquish-var)/.test(arg));
    case "kubectl": return kubectlReads(args);
    case "timeout": {
      const inner = timeoutCommand(args);
      if (!inner) return false;
      seen.wrapper ??= `timeout ${args[args.length - inner.length - 1]}`;
      return wordsLook(inner, seen, depth + 1);
    }
    case "watch": {
      let at = 0;
      while (at < args.length && args[at]!.startsWith("-")) at += /^-(?:n|-interval)$/.test(args[at]!) ? 2 : 1;
      if (at >= args.length) return false;
      seen.wrapper ??= "watch"; seen.loop = true;
      return lineLooks(args.slice(at).join(" "), seen, depth + 1);
    }
    case "perl": return perlAlarm(args, seen, depth);
    case "ssh": return sshLooks(args, seen, depth);
    case "sh": case "bash": case "zsh": {
      const [flags, script, ...more] = args;
      return Boolean(flags && /^-[el]*c[el]*$/.test(flags) && script !== undefined && more.length === 0 && lineLooks(script, seen, depth + 1));
    }
    default:
      return lookCommand(words);
  }
}

const follows = (args: readonly string[]) => args.some((arg) => /^-[a-zA-Z]*[fF][a-zA-Z]*$/.test(arg) || arg === "--follow" || arg.startsWith("--follow="));

/** A URL on this computer's own loopback address: `http://localhost:3000/health`, `127.0.0.1:5000`, `[::1]`. */
const LOOPBACK_URL = /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:[/?#]\S*)?$/i;

/** curl that only fetches to its output: no data, form, upload or method but GET or HEAD, no file written but
 * /dev/null. `loopback`: only from this computer's own server, and no following a redirect away from it. */
export function curlReads(args: readonly string[], options: { loopback?: boolean } = {}): boolean {
  let urls = 0;
  for (let at = 0; at < args.length; at++) {
    const arg = args[at]!;
    if (!arg.startsWith("-")) { if (options.loopback ? !LOOPBACK_URL.test(arg) : !arg) return false; urls++; continue; }
    if (options.loopback && /^(?:--location|-[a-zA-Z]*L[a-zA-Z]*)$/.test(arg)) return false;
    if (/^--(?:silent|show-error|fail|fail-with-body|head|include|location|insecure|compressed|verbose|no-progress-meter|ipv4|ipv6|http1\.1|http2)$/.test(arg)) continue;
    if (/^-[sSfIiLkv46]+$/.test(arg)) continue;
    if (/^(?:-m|--max-time|--connect-timeout|--retry|--retry-delay|--retry-max-time|-H|--header|-u|--user|-A|--user-agent|-e|--referer|--resolve)$/.test(arg)) { at++; continue; }
    if (/^--(?:max-time|connect-timeout|retry|header|user-agent)=/.test(arg)) continue;
    if (/^(?:-X|--request)$/.test(arg)) { if (!["GET", "HEAD"].includes(args[++at] ?? "")) return false; continue; }
    if (/^(?:-o|--output)$/.test(arg)) { if (args[++at] !== "/dev/null") return false; continue; }
    if (/^(?:-w|--write-out)$/.test(arg)) { if (/%output|%\{?stderr/.test(args[++at] ?? "x%output")) return false; continue; }
    return false;
  }
  return urls > 0;
}

const DOCKER_READS = new Set(["ps", "logs", "inspect", "stats", "images", "info", "version", "top", "port", "events", "history", "df"]);
const DOCKER_GROUPS: Record<string, ReadonlySet<string>> = {
  container: new Set(["ls", "ps", "list", "inspect", "logs", "stats", "top", "port"]),
  image: new Set(["ls", "list", "inspect", "history"]),
  network: new Set(["ls", "list", "inspect"]), volume: new Set(["ls", "list", "inspect"]),
  system: new Set(["df", "info", "events"]), context: new Set(["ls", "list", "inspect", "show"]),
  compose: new Set(["ps", "logs", "ls", "top", "images", "config", "version"]),
};

function dockerReads(args: readonly string[]): boolean {
  let at = 0;
  while (at < args.length && args[at]!.startsWith("-")) at += /^(?:-H|--host|--context|-c|--config|-f|--file|-p|--project-name)$/.test(args[at]!) ? 2 : 1;
  const sub = args[at];
  if (sub === undefined) return false;
  if (DOCKER_READS.has(sub)) return true;
  const group = Object.hasOwn(DOCKER_GROUPS, sub) ? DOCKER_GROUPS[sub] : undefined;
  if (!group) return false;
  let next = at + 1;
  while (next < args.length && args[next]!.startsWith("-")) next += /^(?:-f|--file|-p|--project-name|--project-directory|--env-file|--profile)$/.test(args[next]!) ? 2 : 1;
  return group.has(args[next] ?? "");
}

const SYSTEMCTL_READS = new Set(["status", "is-active", "is-enabled", "is-failed", "show", "list-units", "list-unit-files", "list-timers", "cat", "list-dependencies"]);

function systemctlReads(args: readonly string[]): boolean {
  const sub = args.find((arg) => !arg.startsWith("-"));
  return sub !== undefined && SYSTEMCTL_READS.has(sub) && args.every((arg) => !arg.startsWith("-") || /^(?:--user|--system|--no-pager|-l|--full|--all|-a|-q|--quiet|--type=\S+|--state=\S+|-n\d*|--lines=\d+|--value|-p|--property=\S+)$/.test(arg));
}

const KUBECTL_READS = new Set(["get", "describe", "logs", "top", "version", "cluster-info", "explain", "api-resources"]);

function kubectlReads(args: readonly string[]): boolean {
  let at = 0;
  while (at < args.length && args[at]!.startsWith("-")) at += /^(?:-n|--namespace|--context|--kubeconfig)$/.test(args[at]!) ? 2 : 1;
  return KUBECTL_READS.has(args[at] ?? "");
}

/** `perl -e 'alarm 25; exec @ARGV' cmd…` or `perl -e 'alarm 25; exec "cmd …"'`: a time limit around what it runs. */
function perlAlarm(args: readonly string[], seen: Seen, depth: number): boolean {
  if (args[0] !== "-e" || args[1] === undefined) return false;
  const script = /^\s*alarm\s*\(?\s*(\d+)\s*\)?\s*;\s*exec\s*\(?\s*([\s\S]*?)\s*\)?\s*;?\s*$/.exec(args[1]);
  if (!script) return false;
  const run = script[2]!;
  let ok: boolean;
  if (run === "@ARGV") ok = args.length > 2 && wordsLook(args.slice(2), seen, depth + 1);
  else {
    const quoted = /^(?:"([^"$@`\\]*)"|'([^'\\]*)'|q\{([^{}]*)\})$/.exec(run);
    ok = Boolean(quoted) && args.length === 2 && lineLooks(quoted![1] ?? quoted![2] ?? quoted![3]!, seen, depth + 1);
  }
  if (ok) seen.wrapper ??= `alarm ${script[1]}`;
  return ok;
}

/** ssh options that only say how to connect (no local command, forward, background or log file). */
const SSH_SAFE_OPTIONS = /^(?:ConnectTimeout|BatchMode|StrictHostKeyChecking|ServerAliveInterval|ServerAliveCountMax|LogLevel|ConnectionAttempts|UserKnownHostsFile)=/i;

/** `ssh [options] host command…`: the command the other machine runs, read as a line of its own. ssh with no command
 * opens a shell there, which is not a check. */
function sshLooks(args: readonly string[], seen: Seen, depth: number): boolean {
  let at = 0;
  for (; at < args.length && args[at]!.startsWith("-"); at++) {
    const arg = args[at]!;
    if (/^-[46AaCnqTtvxXY]+$/.test(arg)) continue;
    if (/^-[pliJ]$/.test(arg)) { at++; continue; }
    if (/^-[pli]\S+$/.test(arg)) continue;
    if (arg === "-o") { if (!SSH_SAFE_OPTIONS.test(args[++at] ?? "")) return false; continue; }
    if (/^-o\S/.test(arg)) { if (!SSH_SAFE_OPTIONS.test(arg.slice(2))) return false; continue; }
    return false;
  }
  const remote = args.slice(at + 1);
  return args[at] !== undefined && remote.length > 0 && lineLooks(remote.join(" "), seen, depth + 1);
}
