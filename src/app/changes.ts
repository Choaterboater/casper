import { classifyLine, LINE_BREAK } from "../network/risky-lines";
import { commandSegments, segmentTargets } from "../sandbox/remote";
import { remoteChanges, remoteMachine } from "../task/remote-changes";
import { redactPreview } from "../tui/format";

/** A change a step made that stays in view: its row (after the change mark) and, for what went to another machine or a
 * device, the commands sent (secrets hidden), for its box. */
export interface StepChange { row: string; sent?: string[] }

const MAX_SENT = 200;

/** One plain, short line of untrusted text for a row. */
function short(text: string, max = 60): string {
  const line = redactPreview(text).replace(/\s+/g, " ").trim();
  const chars = Array.from(line);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : line;
}

/** "a, b, c" or "a, b, c +2 more". */
function names(list: readonly string[], shown = 3): string {
  return list.length > shown ? `${list.slice(0, shown).join(", ")} +${list.length - shown} more` : list.join(", ");
}

/**
 * What a finished shell command changed beyond this project's files, from its words and output only (display only,
 * never evidence): another machine or a device (the receipt's remote-change rules, or lines the device check calls a
 * change: entering config mode, a commit, a delete), and the setup on this computer when the command succeeded (a
 * package installed or removed, a commit, a push, a branch switch, files deleted).
 */
export function shellChanges(command: string, output: string, ok: boolean, home?: string): StepChange[] {
  const changes: StepChange[] = [];
  // What was sent to each machine by ssh, and how many of those lines a device takes as a change.
  const sent = new Map<string, { lines: string[]; device: boolean }>();
  for (const segment of commandSegments(command)) {
    const parsed = segmentTargets(segment.words);
    const destination = parsed.targets.at(-1);
    if (parsed.tool !== "ssh" || !destination) continue;
    const heredoc = parsed.remote.length <= 3 && command.includes("<<") ? command.slice(command.indexOf("<<")) : "";
    const lines = `${parsed.remote.join(" ")}\n${heredoc}`.split(LINE_BREAK).flatMap(line => line.split(/;|&&|\|\|/))
      .map(line => line.trim()).filter(Boolean);
    const { address } = remoteMachine(destination, home);
    const entry = sent.get(address) ?? { lines: [], device: false };
    entry.lines.push(...lines);
    entry.device ||= lines.some(line => ["change", "dangerous"].includes(classifyLine(line).kind));
    sent.set(address, entry);
  }
  for (const { host, address, changes: found } of remoteChanges(command, home)) {
    const entry = sent.get(address);
    const what = found.length ? found.map(change => short(change, 80)).join(", ")
      : entry?.device ? `sent ${entry.lines.length} config ${entry.lines.length === 1 ? "line" : "lines"}` : undefined;
    if (!what) continue;
    changes.push({ row: `Changed on ${short(host)}: ${what}`, sent: (entry?.lines.length ? entry.lines : [command]).slice(0, MAX_SENT).map(line => redactPreview(line)) });
  }
  if (ok) changes.push(...setupChanges(command, output).map(row => ({ row })));
  return changes;
}

/** Package managers and how they add and remove packages: [program, its add words, its remove words]. */
const PACKAGES: ReadonlyArray<[string, readonly string[], readonly string[]]> = [
  ["npm", ["install", "i", "add"], ["uninstall", "remove", "rm", "un", "r"]],
  ["pnpm", ["add", "install", "i"], ["remove", "rm", "uninstall", "un"]],
  ["yarn", ["add"], ["remove"]],
  ["bun", ["add", "install", "i"], ["remove", "rm"]],
  ["pip", ["install"], ["uninstall"]], ["pip3", ["install"], ["uninstall"]],
  ["uv", ["add"], ["remove"]],
  ["cargo", ["add", "install"], ["remove", "uninstall"]],
  ["go", ["get", "install"], []],
  ["brew", ["install"], ["uninstall", "remove"]],
  ["gem", ["install"], ["uninstall"]],
  ["composer", ["require"], ["remove"]],
  ["apt", ["install"], ["remove", "purge"]], ["apt-get", ["install"], ["remove", "purge"]],
];

/** The program's words: a command's own words, without `VAR=value` before it, `sudo` or `python -m`. */
function programWords(words: readonly string[]): string[] {
  let at = 0;
  while (at < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at]!) || words[at] === "sudo")) at++;
  const rest = words.slice(at);
  // `python3 -m pip install x`, `uv pip install x`: the pip that runs.
  if (/^python[\d.]*$/.test(rest[0] ?? "") && rest[1] === "-m") return rest.slice(2);
  if (rest[0] === "uv" && rest[1] === "pip") return rest.slice(1);
  return rest.map((word, index) => index === 0 ? word.replace(/^.*[\\/]/, "") : word);
}

/** What one successful command changed on this computer's setup, as rows. */
function setupChanges(command: string, output: string): string[] {
  const rows: string[] = [];
  for (const segment of commandSegments(command)) {
    if (segmentTargets(segment.words).tool) continue;
    const [program, sub, ...rest] = programWords(segment.words);
    if (!program) continue;
    const packages = rest.filter(word => !word.startsWith("-"));
    const manager = PACKAGES.find(([name]) => name === program);
    if (manager && sub && packages.length && !rest.includes("-r") && !rest.includes("--requirement")) {
      if (manager[1].includes(sub)) rows.push(`installed ${names(packages.map(name => short(name, 40)))}`);
      else if (manager[2].includes(sub)) rows.push(`removed ${names(packages.map(name => short(name, 40)))}`);
    }
    if (program === "rm" || (program === "git" && sub === "rm")) {
      const files = (program === "rm" ? [sub ?? "", ...rest] : rest).filter(word => word && !word.startsWith("-")).map(file => short(file, 40));
      if (files.length) rows.push(files.length === 1 ? `deleted ${files[0]}` : `deleted ${files.length} files: ${names(files)}`);
    }
    if (program !== "git") continue;
    // git's own options before the subcommand (`git -C app commit`).
    const words = [sub ?? "", ...rest];
    let at = 0;
    while (at < words.length && /^(?:--no-pager|-C|-c)$/.test(words[at]!)) at += words[at] === "--no-pager" ? 1 : 2;
    const git = words[at], args = words.slice(at + 1);
    if (git === "commit") {
      const hash = /^\[[^\]\s]+(?: \([^)]*\))? ([0-9a-f]{7,40})\]/m.exec(output)?.[1];
      const flag = args.findIndex(word => word === "-m" || word === "--message");
      const glued = args.map(word => /^(?:-m|--message=)(.+)$/s.exec(word)?.[1]).find(Boolean);
      const message = flag >= 0 ? args[flag + 1] : glued;
      if (hash) rows.push(`committed ${message ? `"${short(message.split("\n")[0]!, 60)}" ` : ""}(${hash.slice(0, 7)})`);
    } else if (git === "push" && !/Everything up-to-date/.test(output)) {
      const [remote, refspec] = args.filter(word => !word.startsWith("-"));
      const pushed = /^\s*[*+ -]?\s*(?:\[new branch\]|[0-9a-f]+\.{2,3}[0-9a-f]+)\s+(\S+)\s+->\s+(\S+)/m.exec(output);
      const branch = refspec?.split(":")[0] || pushed?.[1];
      if (branch || pushed || remote) rows.push(`pushed ${branch ? short(branch, 40) : args.includes("--tags") ? "tags" : "changes"}${remote ? ` to ${short(remote, 40)}` : ""}`);
    } else if (git === "switch" || git === "checkout") {
      const branch = /Switched to (?:a new )?branch '([^']+)'/.exec(output)?.[1];
      if (branch) rows.push(`switched to ${short(branch, 40)}`);
    }
  }
  return rows;
}

/** Argument names whose value says what an MCP change acts on (a site, a device, a name). */
const TARGET_KEY = /^(?:name|site(?:_?(?:name|id))?|device(?:_?(?:name|id))?|mac|serial|host(?:name)?|switch|ap|id)$/i;

/** An MCP change's row: "Changed in mist: update_site_setting site-1" (the server, the real tool, what it acts on when
 * its arguments say, one level into a router's own arguments). `sent` is already masked. */
export function mcpChangeRow(server: string, tool: string, sent: unknown): string {
  const record = (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const args = record(sent);
  const nested = record(args.arguments ?? args.args ?? args.params);
  const target = [...Object.entries(args), ...Object.entries(nested)]
    .find(([key, value]) => TARGET_KEY.test(key) && (typeof value === "string" || typeof value === "number"))?.[1];
  return `Changed in ${short(server, 40)}: ${short(tool, 60)}${target !== undefined ? ` ${short(String(target), 40)}` : ""}`;
}
