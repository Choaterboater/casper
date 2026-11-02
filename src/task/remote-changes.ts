import { isReadLine } from "../network/risky-lines";
import { remoteReadOnly } from "../sandbox/read-only";
import { commandSegments, resolveTarget, segmentTargets, targetLabel, type RawTarget } from "../sandbox/remote";

/**
 * What a command sent over ssh (or copied with scp/rsync) changed on another machine, read from the command text
 * only: API tokens and keys made, users added, services installed or turned on, packages installed, files written
 * under /etc or /opt, certificates changed. Casper never guesses beyond the words it saw; the receipt says so.
 */

interface ChangeRule { re: RegExp; what: string }

const RULES: ChangeRule[] = [
  { re: /\bpveum\s+(?:user\s+)?token\s+(?:add|create|modify)\b/, what: "made an API token" },
  { re: /\bpvesh\s+(?:create|set)\s+\/?access\/users\/\S*\/token\b/, what: "made an API token" },
  { re: /\b(?:create|generate|add|new|issue)\b[^;&|\n]{0,40}\bapi[ _-]?(?:key|token)s?\b/i, what: "made an API key" },
  { re: /\bssh-keygen\b/, what: "made an SSH key" },
  { re: /\bssh-copy-id\b|\bauthorized_keys\b/, what: "changed SSH keys" },
  { re: /\bpveum\s+(?:user\s+add|useradd)\b|\buseradd\b|\badduser\b/, what: "added a user" },
  { re: /\bpveum\s+(?:acl\s+modify|aclmod)\b|\bpveum\s+(?:user\s+modify|usermod)\b|\busermod\b/, what: "changed user rights" },
  { re: /\bchpasswd\b|(?:^|[\s;&|(])passwd\b(?!\s*-S)/, what: "changed a password" },
  { re: /\/etc\/systemd\/(?:system|user)\/\S+/, what: "installed a service" },
  { re: /\bsystemctl\s+(?:--\S+\s+)*(?:enable|disable|mask|unmask)\b/, what: "turned a service on or off at boot" },
  { re: /\bsystemctl\s+(?:--\S+\s+)*(?:start|restart|stop|reload)\b/, what: "started or stopped a service" },
  { re: /\b(?:apt|apt-get|aptitude)\s+(?:-\S+\s+)*(?:install|remove|purge|upgrade|dist-upgrade|full-upgrade)\b|\b(?:dnf|yum|zypper)\s+(?:-\S+\s+)*(?:install|remove|update|upgrade)\b|\bapk\s+(?:add|del)\b|\bpip3?\s+install\b|\bnpm\s+(?:i|install)\s+(?:-\S+\s+)*-g\b|\bdpkg\s+-i\b|\brpm\s+-[iU]/, what: "installed or removed packages" },
  { re: /\bpvecm\s+updatecerts\b/, what: "renewed the node certificates" },
  { re: /\bpvenode\s+(?:cert|acme)\b|\bcertbot\b|\bupdate-ca-certificates\b|\bupdate-ca-trust\b/, what: "changed certificates" },
  { re: /\b(?:pvecm\s+(?:add|delnode|create)|qm\s+(?:create|destroy|set|start|stop)|pct\s+(?:create|destroy|set|start|stop))\b/, what: "changed the Proxmox cluster or its guests" },
  { re: /(?:^|[\s;&|(])(?:reboot|shutdown|poweroff|halt)\b/, what: "restarted or shut down the machine" },
];

/** A write under /etc or /opt: a redirect, tee, or a file command naming such a path. */
const SYSTEM_WRITE = /(?:>{1,2}\s*|\btee\s+(?:-a\s+)?|\b(?:cp|mv|install|mkdir|ln|touch|chmod|chown|unzip|tar|rm|sed\s+-i\S*|git\s+clone)\b[^;&|\n]*?\s)((?:\/etc|\/opt)(?:\/[^\s;&|'"<>)]*)?)/g;

function snippet(text: string, index: number): string {
  // The command up to the next one, a redirect or a here-document: "/etc/systemd/system/x.service", not "… <<UNIT".
  const rest = text.slice(index).split(/\s*(?:;|&&|\|\||\||\n|<<|>{1,2})\s*/)[0]!.trim();
  return rest.length > 48 ? `${rest.slice(0, 47)}…` : rest;
}

/** What the text of a remote command changes, each as "made an API token (pveum user token add …)". */
export function changesInRemoteText(text: string): string[] {
  const found: string[] = [];
  const add = (line: string) => { if (!found.includes(line)) found.push(line); };
  for (const rule of RULES) {
    const match = rule.re.exec(text);
    if (match) add(`${rule.what} (${snippet(text, match.index)})`);
  }
  const written = new Set<string>();
  for (const match of text.matchAll(SYSTEM_WRITE)) {
    const target = match[1]!.replace(/\/+$/, "");
    if (target && !/^\/etc\/systemd\//.test(target)) written.add(target.length > 48 ? `${target.slice(0, 47)}…` : target);
  }
  if (written.size) add(`wrote ${[...written].slice(0, 3).join(", ")}${written.size > 3 ? ` … +${written.size - 3} more` : ""}`);
  return found;
}

/** Where a remote command went, as the receipt names it: "198.51.100.20 (build-server)", and the address it is kept by. */
export function remoteMachine(raw: RawTarget, home?: string): { host: string; address: string } {
  const target = resolveTarget(raw, home);
  return { host: targetLabel(target).replace(/^another machine \((.*)\)$/, "$1"), address: target.unclear ? target.typed : target.host };
}

/** One command sent to another machine, and whether it only looks there (remoteReadOnly, or a device's `show`). */
export interface SentPiece { text: string; looks: boolean }

/** A device's own read verbs (`show`, `display`, `get`): what risky-lines calls a read, for a switch over ssh. */
const DEVICE_READ = /^\s*(?:do\s+)?(?:sh(?:ow)?|disp(?:lay)?|get|ping|traceroute|tracert|monitor|\?)\b/i;

/** The remote text cut into commands at ; && || and line ends outside quotes and `$(…)`: one per thing that runs there. */
export function remotePieces(text: string): string[] {
  const pieces: string[] = [];
  let current = "", quote: string | undefined, depth = 0;
  const push = () => { if (current.trim()) pieces.push(current.trim()); current = ""; };
  for (let at = 0; at < text.length; at++) {
    const char = text[at]!;
    if (quote) { if (char === "\\" && quote === "\"") { current += char + (text[at + 1] ?? ""); at++; continue; } if (char === quote) quote = undefined; current += char; continue; }
    if (char === "\\") { current += char + (text[at + 1] ?? ""); at++; continue; }
    if (char === "'" || char === "\"") { quote = char; current += char; continue; }
    if (char === "(" && text[at - 1] === "$") depth++;
    else if (char === ")" && depth > 0) depth--;
    if (depth === 0) {
      const two = text.slice(at, at + 2);
      if (two === "&&" || two === "||") { push(); at++; continue; }
      if (char === ";" || char === "\n" || char === "\r") { push(); continue; }
    }
    current += char;
  }
  push();
  return pieces;
}

/** What one ssh segment sends: its remote command, or the here-document a shell there reads (`ssh host bash -s <<EOF`). */
function sentText(remote: readonly string[], command: string): string {
  const at = command.indexOf("<<");
  if (remote.length > 3 || at < 0) return remote.join(" ");
  const marker = /^<<-?\s*['"]?([A-Za-z_][\w-]*)['"]?/.exec(command.slice(at))?.[1];
  const body = command.slice(at).split(/\r?\n/).slice(1);
  const end = marker ? body.findIndex((line) => line.trim() === marker) : -1;
  const script = (end >= 0 ? body.slice(0, end) : body).join("\n");
  // A shell over there that reads the script is not a command of its own.
  const shell = /^(?:sudo\s+(?:-\S+\s+)*)?(?:ba|z|da|k)?sh(?:\s+-s)?$/.test(remote.join(" ").trim()) || !remote.length;
  return shell ? script : `${remote.join(" ")}\n${script}`;
}

/** Every ssh in a command (also inside sh -c, perl's alarm, timeout, env, nohup) with what it sent, piece by piece. */
export function sshSent(command: string): Array<{ destination: RawTarget; pieces: SentPiece[] }> {
  const out: Array<{ destination: RawTarget; pieces: SentPiece[] }> = [];
  for (const segment of commandSegments(command)) {
    const parsed = segmentTargets(segment.words);
    const destination = parsed.targets.at(-1);
    if (parsed.tool !== "ssh" || !destination) continue;
    const pieces = remotePieces(sentText(parsed.remote, command))
      .map((text) => ({ text, looks: remoteReadOnly(text) || (DEVICE_READ.test(text) && isReadLine(text)) }));
    out.push({ destination, pieces });
  }
  return out;
}

/**
 * Changes on other machines, per machine, from one shell command the AI ran. An alias and its address are one
 * machine ("198.51.100.20 (build-server)"). Only the commands that are not looks are read for changes. An ssh whose
 * commands all only looked there is `looked`; one whose text shows no change but did more is listed with no changes:
 * it ran there, and Casper can't tell what it did.
 */
export function remoteChanges(command: string, home?: string): Array<{ host: string; address: string; changes: string[]; looked: boolean }> {
  const out = new Map<string, { host: string; changes: string[]; looked: boolean }>();
  const add = (target: RawTarget, changes: string[], ran: boolean, looked: boolean) => {
    if (!changes.length && !ran) return;
    const { host, address } = remoteMachine(target, home);
    const entry = out.get(address) ?? { host, changes: [], looked: true };
    if (host.length > entry.host.length) entry.host = host;
    for (const change of changes) if (!entry.changes.includes(change)) entry.changes.push(change);
    entry.looked &&= looked && !changes.length;
    out.set(address, entry);
  };
  for (const { destination, pieces } of sshSent(command)) {
    const others = pieces.filter((piece) => !piece.looks).map((piece) => piece.text);
    add(destination, others.length ? changesInRemoteText(others.join("\n")) : [], pieces.length > 0, pieces.length > 0 && !others.length);
  }
  for (const segment of commandSegments(command)) {
    const parsed = segmentTargets(segment.words);
    const destination = parsed.targets.at(-1);
    if (!destination || (parsed.tool !== "scp" && parsed.tool !== "rsync")) continue;
    const last = parsed.args.at(-1) ?? "";
    const remotePath = /^(?:[^@/:\s]+@)?(?:\[[^\]]+\]|[^:/\s\\]{2,})::?(.*)$/.exec(last)?.[1];
    if (remotePath !== undefined && /^\/(?:etc|opt)(?:\/|$)/.test(remotePath)) add(destination, [`copied files to ${remotePath.length > 48 ? `${remotePath.slice(0, 47)}…` : remotePath}`], true, false);
  }
  return [...out].map(([address, { host, changes, looked }]) => ({ host, address, changes, looked }));
}
