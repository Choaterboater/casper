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
function machine(raw: RawTarget, home?: string): { host: string; address: string } {
  const target = resolveTarget(raw, home);
  return { host: targetLabel(target).replace(/^another machine \((.*)\)$/, "$1"), address: target.unclear ? target.typed : target.host };
}

/**
 * Changes on other machines, per machine, from one shell command the AI ran. An alias and its address are one
 * machine ("198.51.100.20 (build-server)"). An ssh command whose text shows no change is listed with no changes: it ran
 * there, and Casper can't tell what it did.
 */
export function remoteChanges(command: string, home?: string): Array<{ host: string; address: string; changes: string[] }> {
  const out = new Map<string, { host: string; changes: string[] }>();
  const add = (target: RawTarget, changes: string[], ran = false) => {
    if (!changes.length && !ran) return;
    const { host, address } = machine(target, home);
    const entry = out.get(address) ?? { host, changes: [] };
    if (host.length > entry.host.length) entry.host = host;
    for (const change of changes) if (!entry.changes.includes(change)) entry.changes.push(change);
    out.set(address, entry);
  };
  for (const segment of commandSegments(command)) {
    const parsed = segmentTargets(segment.words);
    const destination = parsed.targets.at(-1);
    if (!destination) continue;
    if (parsed.tool === "ssh") {
      // `ssh host 'cmd'`, or `ssh host bash -s <<EOF ... EOF` (the here-document is what runs there).
      const heredoc = parsed.remote.length <= 3 && command.includes("<<") ? command.slice(command.indexOf("<<")) : "";
      add(destination, changesInRemoteText(`${parsed.remote.join(" ")}\n${heredoc}`), parsed.remote.length > 0 || heredoc !== "");
    } else if (parsed.tool === "scp" || parsed.tool === "rsync") {
      const last = parsed.args.at(-1) ?? "";
      const remotePath = /^(?:[^@/:\s]+@)?(?:\[[^\]]+\]|[^:/\s\\]{2,})::?(.*)$/.exec(last)?.[1];
      if (remotePath !== undefined && /^\/(?:etc|opt)(?:\/|$)/.test(remotePath)) add(destination, [`copied files to ${remotePath.length > 48 ? `${remotePath.slice(0, 47)}…` : remotePath}`]);
    }
  }
  return [...out].map(([address, { host, changes }]) => ({ host, address, changes }));
}
