import { accessSync, constants, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitInternalPart, realpathLongest, within } from "../platform/project-paths";

/**
 * Commands that reach another machine directly: ssh, scp, sftp, rsync over ssh, nc/ncat/netcat, telnet and socat.
 * Casper reads where each one goes from the command text (user@host, -p, -J, -o Port=...) and resolves ~/.ssh/config
 * aliases itself, outside the sandbox, so the AI never sees that file. A text check, not a shell parser: it is used to
 * ask you first, never to decide that a command is harmless.
 */

export type RemoteTool = "ssh" | "scp" | "sftp" | "rsync" | "nc" | "telnet" | "socat";

export interface RemoteTarget {
  tool: RemoteTool;
  /** The host as the command names it (an alias from ~/.ssh/config, a name or an address). */
  typed: string;
  /** Where it really goes: the alias's HostName, or the typed name. Lower case. */
  host: string;
  /** The command names the machine in a way Casper can't read ($HOST, {}): asked every time, never remembered. */
  unclear?: true;
  user?: string;
  port?: number;
}

/** One piece of a shell line between ; && || | & and newlines, as words with quotes taken off. */
export interface ShellSegment { words: string[]; text: string }

export interface ShellLine {
  segments: ShellSegment[];
  /** One command with no redirection, no pipe and no $(...) or `...`: nothing else runs on this machine. */
  simple: boolean;
}

/** Split a shell line into commands and words. Quotes are respected; anything unusual makes it not simple. */
export function splitShell(text: string): ShellLine {
  const segments: ShellSegment[] = [];
  let words: string[] = [];
  let current = "";
  let started = false;
  let quote: string | undefined;
  let simple = true;
  let segmentStart = 0;
  const endWord = () => { if (started) words.push(current); current = ""; started = false; };
  const endSegment = (index: number) => {
    endWord();
    if (words.length) segments.push({ words, text: text.slice(segmentStart, index).trim() });
    words = [];
    segmentStart = index + 1;
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quote) {
      if (char === quote) quote = undefined;
      else if (quote === "\"" && (char === "`" || (char === "$" && text[index + 1] === "("))) { simple = false; current += char; }
      // As bash reads it: inside double quotes a backslash escapes only $ ` " \ and a newline, and stays otherwise
      // ("..\.ssh" stays ..\.ssh, which Git Bash on Windows reads as a path).
      else if (char === "\\" && quote === "\"" && index + 1 < text.length && "$`\"\\\n".includes(text[index + 1]!)) { index++; if (text[index] !== "\n") current += text[index]; }
      else current += char;
      continue;
    }
    if (char === "'" || char === "\"") { quote = char; started = true; continue; }
    if (char === "\\" && index + 1 < text.length) {
      if (text[index + 1] === "\n") { index++; continue; }
      current += text[++index]; started = true; continue;
    }
    if (char === "\n" || char === ";" || char === "|" || char === "&") {
      simple = false;
      endSegment(index);
      if ((char === "|" || char === "&") && text[index + 1] === char) { index++; segmentStart = index + 1; }
      continue;
    }
    // ( ) `...` and $(...) start or end a command of their own: `(ssh host id)`, `echo $(ssh host id)`.
    if (char === "`" || char === "(" || char === ")" || (char === "$" && text[index + 1] === "(")) {
      simple = false;
      if (char === "$") index++;
      endSegment(index);
      continue;
    }
    if (char === "<" || char === ">") simple = false;
    if (/\s/.test(char)) { endWord(); continue; }
    current += char; started = true;
  }
  endSegment(text.length);
  if (quote) simple = false;
  return { segments, simple: simple && segments.length === 1 };
}

/** Words that run the next command: sudo, env, timeout ... and VAR=value assignments. */
function commandStart(words: string[]): number {
  let index = 0;
  for (let guard = 0; guard < 16 && index < words.length; guard++) {
    const word = words[index]!;
    const name = path.basename(word);
    if (/^[A-Za-z_]\w*=/.test(word)) { index++; continue; }
    // Shell words that come before a command: `then ssh host`, `do ssh $h`, `! ssh host`, `{ ssh host; }`.
    if (SHELL_KEYWORDS.has(word)) { index++; continue; }
    if (["sudo", "doas", "env", "nohup", "command", "exec", "time", "nice", "stdbuf", "ionice", "caffeinate", "eval", "busybox", "setsid", "unbuffer", "chronic", "torsocks"].includes(name)) {
      index++;
      // Their own options (sudo -u root, env -i, nice -n 5): skip dashes and one value for the common ones.
      while (index < words.length && words[index]!.startsWith("-")) {
        const option = words[index]!;
        index++;
        if (["-u", "-g", "-n", "-C", "-h", "-p", "-D", "-o", "-e", "-i"].includes(option) && name !== "env" && index < words.length && !words[index]!.startsWith("-")) index++;
      }
      continue;
    }
    if (name === "timeout") {
      index++;
      while (index < words.length && words[index]!.startsWith("-")) index++;
      index++; // the duration
      continue;
    }
    if (name === "sshpass") {
      index++;
      while (index < words.length && words[index]!.startsWith("-")) {
        const option = words[index]!;
        index++;
        // -p password, -f file, -d fd and -P prompt take a value; -e (password from $SSHPASS) and -v don't.
        if (/^-[pfdP]$/.test(option)) index++;
      }
      continue;
    }
    // `xargs -I{} ssh {} id`, `watch -n 5 ssh host uptime`, `proxychains ssh host`: the command they run.
    if (name === "xargs" || name === "watch" || name === "proxychains" || name === "proxychains4") {
      const valued = name === "xargs" ? /^-[ILnPdEsa]$/ : name === "watch" ? /^-[nd]$/ : /^-f$/;
      index++;
      while (index < words.length && words[index]!.startsWith("-")) {
        const option = words[index]!;
        index++;
        if (valued.test(option)) index++;
      }
      continue;
    }
    break;
  }
  return index;
}

const SHELL_KEYWORDS = new Set(["then", "do", "else", "elif", "if", "while", "until", "!", "{", "}", "time"]);
const SHELLS = new Set(["sh", "bash", "dash", "zsh", "ksh", "ash", "fish"]);

/**
 * Every command in a shell line, also the ones run by `bash -c '...'`, `sh -c "..."` and inside "$(...)" in quotes,
 * so a command can't get past the host question by being wrapped in another shell.
 */
export function commandSegments(text: string, depth = 0): ShellSegment[] {
  const out: ShellSegment[] = [];
  for (const segment of splitShell(text).segments) {
    out.push(segment);
    if (depth >= 4) continue;
    const start = commandStart(segment.words);
    const name = path.basename(segment.words[start] ?? "").replace(/\.exe$/i, "").toLowerCase();
    if (SHELLS.has(name)) {
      const flag = segment.words.findIndex((word, at) => at > start && /^-[a-z]*c[a-z]*$/i.test(word));
      const script = flag >= 0 ? segment.words[flag + 1] : undefined;
      if (script) out.push(...commandSegments(script, depth + 1));
    }
    // "$(ssh host id)" and "`ssh host id`" inside double quotes stay one word; what they run is a command too.
    for (const word of segment.words) {
      const at = word.search(/\$\(|`/);
      if (at >= 0) out.push(...commandSegments(word.slice(at + (word[at] === "$" ? 2 : 1)), depth + 1));
    }
  }
  return out;
}

const SSH_VALUE = new Set("BbcDEeFIiJLlmOoPpQRSWw");
const SCP_VALUE = new Set("cDFiJloPSX");
const SFTP_VALUE = new Set("BbcDFiJloPRSsX");
const NC_VALUE = new Set("pswxXiOITqecgGMmbC");
const TELNET_VALUE = new Set("lenbXk");

interface ParsedOptions { args: string[]; values: Array<[string, string]> }

/** Short options (-p 22, -p22, -tt, -oPort=22), `--` ends them. Long options are kept with their value when joined by =. */
function parseOptions(words: string[], valued: Set<string>, stopAtFirstArg: boolean): ParsedOptions {
  const args: string[] = [];
  const values: Array<[string, string]> = [];
  let index = 0;
  for (; index < words.length; index++) {
    const word = words[index]!;
    if (word === "--") { index++; break; }
    if (word.startsWith("--")) { const eq = word.indexOf("="); values.push([word.slice(0, eq < 0 ? undefined : eq), eq < 0 ? "" : word.slice(eq + 1)]); continue; }
    if (word.startsWith("-") && word.length > 1) {
      for (let at = 1; at < word.length; at++) {
        const flag = word[at]!;
        if (valued.has(flag)) {
          const rest = word.slice(at + 1);
          values.push([`-${flag}`, rest || words[++index] || ""]);
          break;
        }
        values.push([`-${flag}`, ""]);
      }
      continue;
    }
    args.push(word);
    if (stopAtFirstArg) { index++; break; }
  }
  args.push(...words.slice(index));
  return { args, values };
}

/**
 * ssh's words as OpenSSH reads them: options up to the host name, then the host, then options again (ssh parses
 * the rest a second time) until the first word that is not an option or a `--`. What follows is the remote command,
 * whose words are never ssh options (`ssh host ls -la`). Options after the host count like those before it.
 */
function parseSshWords(words: string[]): ParsedOptions & { remote: string[] } {
  const first = parseOptions(words, SSH_VALUE, true);
  const host = first.args[0];
  if (host === undefined) return { ...first, remote: [] };
  const second = parseOptions(first.args.slice(1), SSH_VALUE, true);
  const remote = second.args;
  return { args: [host, ...remote], values: [...first.values, ...second.values], remote };
}

/** [user@]host[:port] and ssh://user@host:port. */
function destination(text: string): { user?: string; host: string; port?: number } | undefined {
  let rest = text.replace(/^(?:ssh|sftp|scp|telnet|rsync):\/\//i, "");
  rest = rest.replace(/\/.*$/, "");
  let user: string | undefined;
  const at = rest.lastIndexOf("@");
  if (at >= 0) { user = rest.slice(0, at); rest = rest.slice(at + 1); }
  let port: number | undefined;
  const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(rest);
  if (bracket) { rest = bracket[1]!; if (bracket[2]) port = Number(bracket[2]); }
  else { const colon = /^([^:]+):(\d+)$/.exec(rest); if (colon) { rest = colon[1]!; port = Number(colon[2]); } }
  if (!rest || !/^[\w.:%-]+$/.test(rest)) return undefined;
  return { host: rest, ...(user ? { user } : {}), ...(port ? { port } : {}) };
}

/** The host part of a scp or rsync argument that names a remote file: host:path, user@host:path, host::module, scp://. */
function remoteFileHost(arg: string): { user?: string; host: string; port?: number } | undefined {
  if (/^(?:scp|rsync|sftp):\/\//i.test(arg)) return destination(arg);
  const match = /^(?:([^@/:\s]+)@)?(\[[^\]]+\]|[^:/\s\\]+)::?/.exec(arg);
  if (!match) return undefined;
  const host = match[2]!.replace(/^\[|\]$/g, "");
  // C:\ and C:/ on Windows are local drives.
  if (/^[A-Za-z]$/.test(host)) return undefined;
  return { host, ...(match[1] ? { user: match[1] } : {}) };
}

/** What ssh's options say about where it goes. `-o HostName=x` is the machine ssh really dials, whatever the alias. */
function sshOptionTargets(values: Array<[string, string]>): { port?: number; user?: string; hostName?: string; jumps: string[] } {
  let port: number | undefined;
  let user: string | undefined;
  let hostName: string | undefined;
  const jumps: string[] = [];
  for (const [flag, value] of values) {
    if (flag === "-p" || flag === "-P") { const n = Number(value); if (Number.isInteger(n) && n > 0) port = n; }
    else if (flag === "-l") user = value;
    else if (flag === "-J") jumps.push(...value.split(",").filter(Boolean));
    else if (flag === "-o") {
      const option = /^\s*(\w+)\s*[= ]\s*(.+?)\s*$/.exec(value);
      if (!option) continue;
      const key = option[1]!.toLowerCase();
      if (key === "port") { const n = Number(option[2]); if (Number.isInteger(n) && n > 0) port = n; }
      else if (key === "user") user = option[2];
      else if (key === "hostname") hostName ??= option[2]!.replace(/^(['"])(.*)\1$/, "$2");
      else if (key === "proxyjump" && option[2]!.toLowerCase() !== "none") jumps.push(...option[2]!.split(",").filter(Boolean));
    }
  }
  return { ...(port ? { port } : {}), ...(user ? { user } : {}), ...(hostName ? { hostName } : {}), jumps };
}

export interface RawTarget {
  tool: RemoteTool; typed: string; user?: string; port?: number; unclear?: true;
  /** The name the command gave when `-o HostName=` sends ssh elsewhere: ~/.ssh/config's User and Port still come from it. */
  alias?: string;
}

/** A host Casper can't read from the text ($HOST, {} from xargs): it still asks, and never remembers the answer. */
const PLAIN_HOST = /^[\w.:%-]+$/;

/** The remote targets of one command (its words, after sudo/env/timeout), and the words that run on the far side. */
export function segmentTargets(words: string[]): { tool?: RemoteTool; targets: RawTarget[]; remote: string[]; values: Array<[string, string]>; args: string[] } {
  const start = commandStart(words);
  const name = path.basename(words[start] ?? "").replace(/\.exe$/i, "").toLowerCase();
  const rest = words.slice(start + 1);
  const targets: RawTarget[] = [];
  const add = (tool: RemoteTool, given: { user?: string; host: string; port?: number } | undefined, extra: { user?: string; port?: number; hostName?: string } = {}, raw?: string) => {
    // `-o HostName=x`: ssh dials x, whatever the command names; the name still picks User and Port from ~/.ssh/config.
    const found = given && extra.hostName ? { ...given, host: extra.hostName } : given;
    const alias = given && extra.hostName ? given.host : undefined;
    if (!found) {
      // ssh root@$HOST, nc $IP 22: a machine all the same, which Casper can't name.
      if (raw) targets.push({ tool, typed: raw.replace(/^[^@]*@/, "").replace(/:.*$/, "") || raw, unclear: true });
      return;
    }
    const user = found.user ?? extra.user;
    const port = found.port ?? extra.port;
    targets.push({ tool, typed: found.host, ...(user ? { user } : {}), ...(port ? { port } : {}), ...(alias ? { alias } : {}), ...(PLAIN_HOST.test(found.host) ? {} : { unclear: true as const }) });
  };
  if (name === "ssh" || name === "autossh" || name === "ssh-copy-id" || name === "mosh") {
    const { args, values, remote } = parseSshWords(rest);
    const options = sshOptionTargets(values);
    for (const jump of options.jumps) add("ssh", destination(jump), {}, jump);
    add("ssh", args[0] ? destination(args[0]) : undefined, options, args[0]);
    return { tool: "ssh", targets, remote, values, args };
  }
  if (name === "scp") {
    const { args, values } = parseOptions(rest, SCP_VALUE, false);
    const options = sshOptionTargets(values);
    for (const jump of options.jumps) add("scp", destination(jump));
    for (const arg of args) add("scp", remoteFileHost(arg), options, arg.startsWith("$") ? arg : undefined);
    return { tool: "scp", targets, remote: [], values, args };
  }
  if (name === "sftp") {
    const { args, values } = parseOptions(rest, SFTP_VALUE, true);
    const options = sshOptionTargets(values);
    for (const jump of options.jumps) add("sftp", destination(jump));
    add("sftp", args[0] ? remoteFileHost(args[0]) ?? destination(args[0]) : undefined, options, args[0]);
    return { tool: "sftp", targets, remote: [], values, args };
  }
  if (name === "rsync") {
    const { args, values } = parseOptions(rest, new Set("efBMT"), false);
    const shell = values.find(([flag]) => flag === "-e" || flag === "--rsh")?.[1];
    const shellOptions = shell ? sshOptionTargets(parseOptions(splitShell(shell).segments[0]?.words.slice(1) ?? [], SSH_VALUE, false).values) : { jumps: [] };
    for (const arg of args) add("rsync", remoteFileHost(arg), shellOptions, arg.startsWith("$") ? arg : undefined);
    return { tool: "rsync", targets, remote: [], values, args };
  }
  if (name === "nc" || name === "ncat" || name === "netcat") {
    const { args, values } = parseOptions(rest, NC_VALUE, false);
    if (values.some(([flag]) => flag === "-l" || flag === "--listen")) return { tool: "nc", targets, remote: [], values, args };
    const port = Number(args[1]);
    add("nc", args[0] ? destination(args[0]) : undefined, Number.isInteger(port) && port > 0 ? { port } : {}, args[0]);
    return { tool: "nc", targets, remote: [], values, args };
  }
  if (name === "telnet") {
    const { args, values } = parseOptions(rest, TELNET_VALUE, false);
    const port = Number(args[1]);
    const user = values.find(([flag]) => flag === "-l")?.[1];
    add("telnet", args[0] ? destination(args[0]) : undefined, { ...(Number.isInteger(port) && port > 0 ? { port } : {}), ...(user ? { user } : {}) }, args[0]);
    return { tool: "telnet", targets, remote: [], values, args };
  }
  if (name === "socat") {
    for (const arg of rest) {
      const match = /^(?:tcp[46]?(?:-connect)?|openssl(?:-connect)?|ssl|udp[46]?(?:-connect|-sendto)?|socks4a?|proxy(?:-connect)?):([^:,\s]+)(?::(\d+))?/i.exec(arg);
      if (match) add("socat", { host: match[1]!.replace(/^\[|\]$/g, ""), ...(match[2] ? { port: Number(match[2]) } : {}) });
    }
    return { tool: "socat", targets, remote: [], values: [], args: rest };
  }
  return { targets, remote: [], values: [], args: rest };
}

interface SshConfigBlock { patterns: string[]; hostName?: string; user?: string; port?: number }

function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
  return re.test(value);
}

/** The Host blocks of an ssh config file (HostName, User, Port only). Match blocks and Include are left out. */
export function parseSshConfig(text: string): SshConfigBlock[] {
  const blocks: SshConfigBlock[] = [{ patterns: ["*"] }];
  let current: SshConfigBlock | undefined = blocks[0];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const match = /^(\S+?)\s*(?:=\s*|\s+)(.+)$/.exec(line);
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    const value = match[2]!.trim().replace(/^"(.*)"$/, "$1");
    if (key === "host") { current = { patterns: value.split(/\s+/) }; blocks.push(current); continue; }
    if (key === "match") { current = undefined; continue; }
    if (!current) continue;
    if (key === "hostname") current.hostName ??= value;
    else if (key === "user") current.user ??= value;
    else if (key === "port") { const n = Number(value); if (Number.isInteger(n) && n > 0) current.port ??= n; }
  }
  return blocks;
}

/** What ~/.ssh/config says about `alias`: first value wins, as ssh reads it. */
export function resolveSshAlias(alias: string, blocks: SshConfigBlock[]): { hostName?: string; user?: string; port?: number } {
  const out: { hostName?: string; user?: string; port?: number } = {};
  for (const block of blocks) {
    const negated = block.patterns.some((pattern) => pattern.startsWith("!") && globMatch(pattern.slice(1), alias));
    if (negated || !block.patterns.some((pattern) => !pattern.startsWith("!") && globMatch(pattern, alias))) continue;
    if (block.hostName && !out.hostName) out.hostName = block.hostName.replace(/%h/g, alias);
    if (block.user && !out.user) out.user = block.user;
    if (block.port && !out.port) out.port = block.port;
  }
  return out;
}

function readSshConfig(home: string): SshConfigBlock[] {
  const file = path.join(home, ".ssh", "config");
  try { if (statSync(file).size > 512 * 1024) return []; return parseSshConfig(readFileSync(file, "utf8")); } catch { return []; }
}

/**
 * Every machine a shell line reaches directly, with ~/.ssh/config aliases resolved (ssh, scp, sftp and rsync).
 * The config is read here, by Casper, and never shown to the AI.
 */
export function remoteTargets(command: string, home = os.homedir()): RemoteTarget[] {
  const found: RemoteTarget[] = [];
  let config: SshConfigBlock[] | undefined;
  for (const segment of commandSegments(command)) {
    for (const raw of segmentTargets(segment.words).targets) {
      let host = raw.typed;
      let { user, port } = raw;
      if (raw.unclear) {
        const target: RemoteTarget = { tool: raw.tool, typed: raw.typed, host: `?${raw.typed}`, unclear: true };
        if (!found.some((entry) => entry.host === target.host)) found.push(target);
        continue;
      }
      if (raw.tool === "ssh" || raw.tool === "scp" || raw.tool === "sftp" || raw.tool === "rsync") {
        config ??= readSshConfig(home);
        const alias = resolveSshAlias(raw.alias ?? raw.typed, config);
        if (alias.hostName && !raw.alias) host = alias.hostName;
        user ??= alias.user;
        port ??= alias.port;
      }
      const target: RemoteTarget = { tool: raw.tool, typed: raw.typed, host: host.toLowerCase(), ...(user ? { user } : {}), ...(port ? { port } : {}) };
      if (!found.some((entry) => entry.host === target.host && entry.typed === target.typed)) found.push(target);
    }
  }
  return found;
}

/** One machine as the command named it, resolved through ~/.ssh/config the way remoteTargets does. */
export function resolveTarget(raw: RawTarget, home = os.homedir()): RemoteTarget {
  if (raw.unclear) return { tool: raw.tool, typed: raw.typed, host: `?${raw.typed}`, unclear: true };
  let host = raw.typed;
  let { user, port } = raw;
  if (raw.tool === "ssh" || raw.tool === "scp" || raw.tool === "sftp" || raw.tool === "rsync") {
    const alias = resolveSshAlias(raw.alias ?? raw.typed, readSshConfig(home));
    if (alias.hostName && !raw.alias) host = alias.hostName;
    user ??= alias.user;
    port ??= alias.port;
  }
  return { tool: raw.tool, typed: raw.typed, host: host.toLowerCase(), ...(user ? { user } : {}), ...(port ? { port } : {}) };
}

/** "10.0.0.5 (build-server)" or "build-server". */
export function targetLabel(target: RemoteTarget): string {
  if (target.unclear) return `another machine (${target.typed})`;
  return target.typed.toLowerCase() !== target.host ? `${target.host} (${target.typed})` : target.host;
}

/** ssh -o settings that run a program on this machine, write a file of its choosing here, or open a way in for other commands. */
const LOCAL_EFFECT_OPTION = /^\s*(?:proxycommand|localcommand|permitlocalcommand|knownhostscommand|proxyusefdpass|controlmaster|controlpath|controlpersist|localforward|remoteforward|dynamicforward|tunnel|tunneldevice|forwardagent|forwardx11|forwardx11trusted|include|sessiontype|stdinnull|forkafterauthentication|securitykeyprovider|pkcs11provider|identityagent|remotecommand|canonicalizehostname)\b/i;
/** -o UserKnownHostsFile names a file ssh adds new hosts to. /dev/null, none and NUL write nothing (a common lab
 * pattern), so only another file counts. GlobalKnownHostsFile is only ever read. */
function writesKnownHosts(value: string): boolean {
  const match = /^\s*userknownhostsfile\b\s*=?\s*(.*)$/is.exec(value);
  if (!match) return false;
  const files = match[1]!.trim().split(/\s+/);
  return !files.every((file) => /^(?:\/dev\/null|none|nul)$/i.test(file));
}
/** ssh and scp flags that run a program here, forward ports or the agent, go to the background or print the settings. */
const LOCAL_EFFECT_FLAG = new Set(["-D", "-L", "-R", "-W", "-w", "-f", "-N", "-M", "-S", "-O", "-E", "-A", "-X", "-Y", "-G", "-F", "-I", "-e", "-3"]);

/**
 * Whether an approved ssh or scp command can run outside the sandbox, with your own keys: one plain ssh or scp (no
 * pipe, redirect or $(...)), named bare so the shell finds it on the PATH (see trustedProgram), no option that runs
 * a program here, forwards a port or the agent, or goes to the background, and (scp) local files only inside the
 * project. Anything else stays in the sandbox.
 */
/** `ssh`, or on Windows `ssh.exe` in any case: a bare name with no folder. Whether the program of that name is the
 * system's is trustedProgram's question. */
function isBareName(word: string, tool: string): boolean {
  return word === tool || word.toLowerCase() === `${tool}.exe`;
}

export function runsAlone(command: string, root: string, cwd = root, places: LocalPlaces = {}): boolean {
  const line = splitShell(command);
  if (!line.simple) return false;
  const words = line.segments[0]!.words;
  const start = commandStart(words);
  // No sudo, env or VAR= in front: exactly what the question showed runs.
  if (start !== 0) return false;
  const parsed = segmentTargets(words);
  // `./ssh` or `bin/scp` is a program of that name, wherever it came from: only the bare name is ssh or scp.
  if (!parsed.targets.length || parsed.targets.some((target) => target.unclear) || (parsed.tool !== "ssh" && parsed.tool !== "scp") || !isBareName(words[0]!, parsed.tool)) return false;
  for (const [flag, value] of parsed.values) {
    if (flag.startsWith("--") || LOCAL_EFFECT_FLAG.has(flag)) return false;
    if (flag === "-o" && (LOCAL_EFFECT_OPTION.test(value) || writesKnownHosts(value))) return false;
  }
  if (parsed.tool === "scp" && !scpLocalFilesSafe(parsed.args, parsed.values.some(([flag]) => flag === "-r"), root, cwd, places)) return false;
  return true;
}

/** The sandbox's own answers about places, so scp is held to the same rules as a sandboxed command. */
export interface LocalPlaces {
  /** Whether a command run in the sandbox could not write `absolute` (read-only: git's own files, private places). */
  writeBlocked?: (absolute: string) => boolean;
  /** Whether `absolute` is a private place the sandbox hides. */
  readBlocked?: (absolute: string) => boolean;
}

/** Where a path lands when the OS follows it step by step: a `..` after a link goes back from the link's target. */
function physicalPath(cwd: string, arg: string): string {
  let current = realpathLongest(cwd);
  if (path.isAbsolute(arg)) current = path.parse(arg).root;
  for (const part of arg.split(/[\\/]+/)) {
    if (!part || part === ".") continue;
    current = part === ".." ? path.dirname(current) : realpathLongest(path.join(current, part));
  }
  return current;
}

const WALK_LIMIT = 2000;
const WALK_DEPTH = 16;

/**
 * Whether the files under `dir` can be copied without surprises: no link in it leads outside `root` or to a place
 * `blocked` names, and (`deep`, for scp -r) the same for every folder below it. false when the walk is too big or
 * can't be read: an unclear folder is not plain.
 */
function treeIsSafe(dir: string, root: string, blocked: (absolute: string) => boolean, deep: boolean, budget = { left: WALK_LIMIT }, depth = 0): boolean {
  if (depth > WALK_DEPTH) return false;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const entry of entries) {
    if (--budget.left < 0) return false;
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      let real: string;
      try { real = realpathSync(file); } catch { return false; } // a link to nowhere is created through
      if (!within(root, real) || blocked(real)) return false;
    } else if (entry.isDirectory() && deep) {
      if (blocked(file) || !treeIsSafe(file, root, blocked, deep, budget, depth + 1)) return false;
    }
  }
  return true;
}

/**
 * scp's local side must be inside the project and clear of what the sandbox protects: git's own files, private
 * places, links that lead out. The last argument is where files are written; a folder there (or any folder sent)
 * gets its links checked, since the far side picks the names created in it.
 */
function scpLocalFilesSafe(args: string[], recursive: boolean, root: string, cwd: string, places: LocalPlaces): boolean {
  const realRoot = realpathLongest(root);
  const home = os.homedir();
  const writeBlocked = (absolute: string) => gitInternalPart(absolute, root, home) !== undefined || places.writeBlocked?.(absolute) === true;
  const readBlocked = (absolute: string) => places.readBlocked?.(absolute) === true;
  const kind = (absolute: string) => { try { return statSync(absolute); } catch { return undefined; } };
  const last = args.length - 1;
  for (const [at, arg] of args.entries()) {
    if (remoteFileHost(arg)) continue;
    // ~, $VAR and globs expand in the shell to places this check can't see.
    if (/^~|[$*?[{]/.test(arg)) return false;
    const local = physicalPath(cwd, arg);
    if (!within(realRoot, local) || readBlocked(local)) return false;
    const written = at === last;
    if (written && writeBlocked(local)) return false;
    if (!kind(local)?.isDirectory()) continue;
    if (!treeIsSafe(local, realRoot, written ? writeBlocked : readBlocked, written ? recursive : true)) return false;
    if (!written) continue;
    // Files land in this folder under names the far side picks: not over git's own entries (a folder of that name
    // only with -r).
    let names: string[];
    try { names = readdirSync(local); } catch { return false; }
    for (const name of names) {
      const child = path.join(local, name);
      if (writeBlocked(child) && (recursive || !kind(child)?.isDirectory())) return false;
    }
  }
  return true;
}

/**
 * The program a bare `name` runs as, when nothing the sandbox lets commands write can change which one that is:
 * every folder on `searchPath` up to the one that has it is absolute (an empty or relative entry is searched from
 * the current folder) and not `writable`, and so is the file itself, through links. undefined otherwise, or when no
 * folder has it. A program found in `ownBin` (Casper's own bin folder, searched first) is not the system's, so
 * undefined too.
 */
export function trustedProgram(name: string, searchPath: string, writable: (place: string) => boolean, ownBin?: string, platform: NodeJS.Platform = process.platform): string | undefined {
  // A name with a folder in it is not looked up on the PATH at all.
  if (!name || /[\\/]/.test(name)) return undefined;
  for (const dir of searchPath.split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir) || writable(dir)) return undefined;
    // On Windows the shell finds ssh.exe when asked for ssh.
    const file = [path.join(dir, name), ...(platform === "win32" ? [path.join(dir, `${name}.exe`)] : [])].find((candidate) => {
      try { return statSync(candidate).isFile() && (accessSync(candidate, constants.X_OK), true); } catch { return false; }
    });
    if (!file) continue;
    if (ownBin && within(realpathLongest(ownBin), realpathLongest(file))) return undefined;
    return writable(file) ? undefined : file;
  }
  return undefined;
}
