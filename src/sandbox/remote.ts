import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { realpathLongest, within } from "../platform/project-paths";

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
      else if (char === "\\" && quote === "\"" && index + 1 < text.length) current += text[++index];
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
    if (char === "<" || char === ">" || char === "`" || (char === "$" && text[index + 1] === "(") || char === "(" || char === ")") simple = false;
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
    if (["sudo", "doas", "env", "nohup", "command", "exec", "time", "nice", "stdbuf", "ionice", "caffeinate"].includes(name)) {
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
        if (/^-[pfde]$/.test(option)) index++;
      }
      continue;
    }
    break;
  }
  return index;
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

function sshOptionTargets(values: Array<[string, string]>): { port?: number; user?: string; jumps: string[] } {
  let port: number | undefined;
  let user: string | undefined;
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
      else if (key === "proxyjump" && option[2]!.toLowerCase() !== "none") jumps.push(...option[2]!.split(",").filter(Boolean));
    }
  }
  return { ...(port ? { port } : {}), ...(user ? { user } : {}), jumps };
}

interface RawTarget { tool: RemoteTool; typed: string; user?: string; port?: number }

/** The remote targets of one command (its words, after sudo/env/timeout), and the words that run on the far side. */
export function segmentTargets(words: string[]): { tool?: RemoteTool; targets: RawTarget[]; remote: string[]; values: Array<[string, string]>; args: string[] } {
  const start = commandStart(words);
  const name = path.basename(words[start] ?? "").replace(/\.exe$/i, "").toLowerCase();
  const rest = words.slice(start + 1);
  const targets: RawTarget[] = [];
  const add = (tool: RemoteTool, found: { user?: string; host: string; port?: number } | undefined, extra: { user?: string; port?: number } = {}) => {
    if (!found) return;
    const user = found.user ?? extra.user;
    const port = found.port ?? extra.port;
    targets.push({ tool, typed: found.host, ...(user ? { user } : {}), ...(port ? { port } : {}) });
  };
  if (name === "ssh" || name === "autossh") {
    const { args, values } = parseOptions(rest, SSH_VALUE, true);
    const options = sshOptionTargets(values);
    for (const jump of options.jumps) add("ssh", destination(jump));
    add("ssh", args[0] ? destination(args[0]) : undefined, options);
    return { tool: "ssh", targets, remote: args.slice(1), values, args };
  }
  if (name === "scp") {
    const { args, values } = parseOptions(rest, SCP_VALUE, false);
    const options = sshOptionTargets(values);
    for (const jump of options.jumps) add("scp", destination(jump));
    for (const arg of args) add("scp", remoteFileHost(arg), options);
    return { tool: "scp", targets, remote: [], values, args };
  }
  if (name === "sftp") {
    const { args, values } = parseOptions(rest, SFTP_VALUE, true);
    const options = sshOptionTargets(values);
    for (const jump of options.jumps) add("sftp", destination(jump));
    add("sftp", args[0] ? remoteFileHost(args[0]) ?? destination(args[0]) : undefined, options);
    return { tool: "sftp", targets, remote: [], values, args };
  }
  if (name === "rsync") {
    const { args, values } = parseOptions(rest, new Set("efBMT"), false);
    const shell = values.find(([flag]) => flag === "-e" || flag === "--rsh")?.[1];
    const shellOptions = shell ? sshOptionTargets(parseOptions(splitShell(shell).segments[0]?.words.slice(1) ?? [], SSH_VALUE, false).values) : { jumps: [] };
    for (const arg of args) add("rsync", remoteFileHost(arg), shellOptions);
    return { tool: "rsync", targets, remote: [], values, args };
  }
  if (name === "nc" || name === "ncat" || name === "netcat") {
    const { args, values } = parseOptions(rest, NC_VALUE, false);
    if (values.some(([flag]) => flag === "-l" || flag === "--listen")) return { tool: "nc", targets, remote: [], values, args };
    const port = Number(args[1]);
    add("nc", args[0] ? destination(args[0]) : undefined, Number.isInteger(port) && port > 0 ? { port } : {});
    return { tool: "nc", targets, remote: [], values, args };
  }
  if (name === "telnet") {
    const { args, values } = parseOptions(rest, TELNET_VALUE, false);
    const port = Number(args[1]);
    const user = values.find(([flag]) => flag === "-l")?.[1];
    add("telnet", args[0] ? destination(args[0]) : undefined, { ...(Number.isInteger(port) && port > 0 ? { port } : {}), ...(user ? { user } : {}) });
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
  for (const segment of splitShell(command).segments) {
    for (const raw of segmentTargets(segment.words).targets) {
      let host = raw.typed;
      let { user, port } = raw;
      if (raw.tool === "ssh" || raw.tool === "scp" || raw.tool === "sftp" || raw.tool === "rsync") {
        config ??= readSshConfig(home);
        const alias = resolveSshAlias(raw.typed, config);
        if (alias.hostName) host = alias.hostName;
        user ??= alias.user;
        port ??= alias.port;
      }
      const target: RemoteTarget = { tool: raw.tool, typed: raw.typed, host: host.toLowerCase(), ...(user ? { user } : {}), ...(port ? { port } : {}) };
      if (!found.some((entry) => entry.host === target.host && entry.typed === target.typed)) found.push(target);
    }
  }
  return found;
}

/** "10.0.0.5 (lab-01)" or "lab-01". */
export function targetLabel(target: RemoteTarget): string {
  return target.typed.toLowerCase() !== target.host ? `${target.host} (${target.typed})` : target.host;
}

/** ssh -o settings that run a program on this machine, or open a way in for other commands. */
const LOCAL_EFFECT_OPTION = /^\s*(?:proxycommand|localcommand|permitlocalcommand|knownhostscommand|proxyusefdpass|controlmaster|controlpath|controlpersist|localforward|remoteforward|dynamicforward|tunnel|tunneldevice|forwardagent|forwardx11|forwardx11trusted|include|sessiontype|stdinnull|forkafterauthentication|securitykeyprovider|pkcs11provider|identityagent|remotecommand|canonicalizehostname)\b/i;
/** ssh and scp flags that run a program here, forward ports or the agent, go to the background or print the settings. */
const LOCAL_EFFECT_FLAG = new Set(["-D", "-L", "-R", "-W", "-w", "-f", "-N", "-M", "-S", "-O", "-E", "-A", "-X", "-Y", "-G", "-F", "-I", "-e", "-3"]);

/**
 * Whether an approved ssh or scp command can run outside the sandbox, with your own keys: one plain ssh or scp (no
 * pipe, redirect or $(...)), no option that runs a program here, forwards a port or the agent, or goes to the
 * background, and (scp) local files only inside the project. Anything else stays in the sandbox.
 */
export function runsAlone(command: string, root: string): boolean {
  const line = splitShell(command);
  if (!line.simple) return false;
  const words = line.segments[0]!.words;
  const start = commandStart(words);
  // No sudo, env or VAR= in front: exactly what the question showed runs.
  if (start !== 0) return false;
  const parsed = segmentTargets(words);
  if (!parsed.targets.length || (parsed.tool !== "ssh" && parsed.tool !== "scp")) return false;
  for (const [flag, value] of parsed.values) {
    if (flag.startsWith("--") || LOCAL_EFFECT_FLAG.has(flag)) return false;
    if (flag === "-o" && LOCAL_EFFECT_OPTION.test(value)) return false;
  }
  if (parsed.tool === "scp") {
    for (const arg of parsed.args) {
      if (remoteFileHost(arg)) continue;
      // ~, $VAR and globs expand in the shell to places this check can't see.
      if (/^~|[$*?[{]/.test(arg)) return false;
      const local = realpathLongest(path.resolve(root, arg));
      if (!within(realpathLongest(root), local)) return false;
    }
  }
  return true;
}
