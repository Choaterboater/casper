import { appendFileSync, chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { hideCommandSecrets } from "../secrets/files";
import { redactPreview } from "./format";
import { hostCommand, type HostCommand, type HostTerminal } from "./host-terminal";

/** Where the busy steps and helper activity go while Casper works. */
export interface ActivityPane {
  /** The Working box's current lines: each line not shown before is added to the pane. */
  show(lines: readonly string[]): void;
  /** One line of its own (a helper's step). */
  log(line: string): void;
  /** Close the pane and remove its log. Idempotent and synchronous, so it can run at exit. */
  close(): void;
}

export interface SidePaneOptions {
  host: HostTerminal;
  /** Environment for tmux and osascript (tests point $TMUX at a private server). */
  env?: Record<string, string | undefined>;
  run?: HostCommand;
  /** The process the pane watches: when it is gone, the pane closes itself (default: this process). */
  pid?: number;
  platform?: NodeJS.Platform;
  /** Folder for the log (default: the system temp folder). */
  tempDir?: string;
  /** Clock for the time on each line (tests). */
  now?: () => Date;
}

const HEADER = "Casper · steps and helpers (view only; closes when Casper exits)\n";
/** A long session's log starts over past this size; the pane shows only its end anyway. */
const MAX_LOG_BYTES = 2 * 1024 * 1024;
/** "Waiting for model · 12s": the running timer is not news. */
const TIMER = / · \d+(?:m\d{2})?s$/;

/** POSIX single quotes: the pane's script runs under /bin/sh, never the user's own shell. */
function quote(text: string): string { return `'${text.replaceAll("'", "'\\''")}'`; }

/**
 * A view-only pane beside Casper: `tail` of a log only Casper writes. Casper opens it on the first busy step,
 * never sends it keys (tmux input is switched off for it), and closes it at exit. The pane also watches
 * Casper's process id and closes itself when Casper is gone, so a crash or kill never leaves it behind.
 * Only the pane Casper opened is ever closed; the user's other panes are never touched.
 */
export class SidePane implements ActivityPane {
  private closed = false;
  private shown = new Set<string>();
  private bytes = 0;
  private readonly onExit = () => this.close();
  private readonly onHangup = () => { this.close(); process.removeListener("SIGHUP", this.onHangup); process.kill(process.pid, "SIGHUP"); };

  private constructor(readonly file: string, private readonly dir: string, private readonly closePane: () => void,
    private readonly now: () => Date) {
    process.once("exit", this.onExit);
    // A hang-up with nobody else listening would end Casper without its exit handlers: close first, then hang up.
    if (process.listenerCount("SIGHUP") === 0) process.once("SIGHUP", this.onHangup);
  }

  /** Opens the pane when Casper is inside tmux (its own pane known) or iTerm2 on a Mac; undefined otherwise. */
  static open(options: SidePaneOptions): SidePane | undefined {
    const { host } = options;
    const platform = options.platform ?? process.platform;
    const iterm = !host.tmux && host.iterm && host.itermSession !== undefined && platform === "darwin";
    if (!host.tmuxPane && !iterm) return undefined;
    const run = options.run ?? hostCommand(options.env);
    let dir: string | undefined;
    try {
      dir = mkdtempSync(path.join(options.tempDir ?? os.tmpdir(), "casper-steps-"));
      const file = path.join(dir, "steps.log");
      const script = path.join(dir, "pane.sh");
      writeFileSync(file, HEADER, { mode: 0o600 });
      const pid = options.pid ?? process.pid;
      // tail follows the log; the loop ends it when Casper's process is gone, and the pane closes with it.
      writeFileSync(script, [
        `tail -n 200 -f ${quote(file)} 2>/dev/null &`, "t=$!",
        `while kill -0 ${pid} 2>/dev/null; do sleep 1; done`, "kill \"$t\" 2>/dev/null", "",
      ].join("\n"), { mode: 0o700 });
      chmodSync(dir, 0o700);
      const closePane = host.tmuxPane ? openTmux(run, host.tmuxPane, script) : openITerm(run, host.itermSession!, script);
      if (!closePane) { rmSync(dir, { recursive: true, force: true }); return undefined; }
      return new SidePane(file, dir, closePane, options.now ?? (() => new Date()));
    } catch {
      if (dir) rmSync(dir, { recursive: true, force: true });
      return undefined;
    }
  }

  show(lines: readonly string[]): void {
    for (const line of lines) {
      const key = line.replace(TIMER, "");
      if (this.shown.has(key)) continue;
      this.shown.add(key);
      this.log(key);
    }
    // Only the box's current lines matter for what is new next time.
    const current = new Set(lines.map(line => line.replace(TIMER, "")));
    for (const key of this.shown) if (!current.has(key)) this.shown.delete(key);
  }

  log(line: string): void {
    if (this.closed) return;
    // A helper's goal is the model's own words ("log in as root / Lab-Pass-1"): the full secret rules, then the screen's.
    const text = redactPreview(hideCommandSecrets(line).text).replace(/\s+/g, " ").trim();
    if (!text) return;
    const time = this.now().toTimeString().slice(0, 8);
    const entry = `${time} ${text}\n`;
    try {
      if (this.bytes + entry.length > MAX_LOG_BYTES) { writeFileSync(this.file, HEADER); this.bytes = 0; }
      appendFileSync(this.file, entry);
      this.bytes += Buffer.byteLength(entry);
    } catch { /* the pane is a view; a failed write never stops the work */ }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    process.removeListener("exit", this.onExit);
    process.removeListener("SIGHUP", this.onHangup);
    try { this.closePane(); } catch { /* already gone */ }
    try { statSync(this.dir); rmSync(this.dir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
}

/** A pane to the right of Casper's own, not focused, with input switched off. Returns its closer. */
function openTmux(run: HostCommand, pane: string, script: string): (() => void) | undefined {
  const split = (size: string[]) => run(["tmux", "split-window", "-h", "-d", ...size, "-t", pane, "-P", "-F", "#{pane_id}", "/bin/sh", script]);
  let result = split(["-l", "38%"]);
  if (result.status !== 0) result = split(["-p", "38"]); // tmux before 3.1
  const id = result.stdout.trim();
  if (result.status !== 0 || !/^%\d+$/.test(id)) return undefined;
  // View only: tmux drops any key sent to it, from a person or anything else.
  run(["tmux", "select-pane", "-d", "-t", id]);
  run(["tmux", "select-pane", "-t", id, "-T", "Casper steps"]);
  run(["tmux", "set-option", "-p", "-t", id, "remain-on-exit", "off"]);
  // Pane ids are never reused by a tmux server, so this closes only the pane Casper opened.
  return () => { run(["tmux", "kill-pane", "-t", id]); };
}

/** An iTerm2 split beside Casper's own session, through iTerm2's scripting. Returns its closer. */
function openITerm(run: HostCommand, session: string, script: string): (() => void) | undefined {
  const find = (body: string) => [
    "tell application \"iTerm2\"",
    "repeat with w in windows", "repeat with t in tabs of w", "repeat with s in sessions of t",
    body,
    "end repeat", "end repeat", "end repeat", "end tell",
  ].flatMap(line => ["-e", line]);
  const result = run(["osascript", ...find(`if unique id of s is ${JSON.stringify(session)} then
tell s to set p to (split vertically with default profile command ${JSON.stringify(`/bin/sh ${script}`)})
return unique id of p
end if`)]);
  const id = result.stdout.trim();
  if (result.status !== 0 || !/^[0-9A-Fa-f-]{8,64}$/.test(id)) return undefined;
  return () => { run(["osascript", ...find(`if unique id of s is ${JSON.stringify(id)} then close s`)]); };
}
