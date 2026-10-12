import { spawnSync } from "node:child_process";

/**
 * The terminal Casper runs in, read from the environment only: nothing to set up. Casper never starts
 * tmux; it only notices when it is already inside it (or inside iTerm2) and fits itself to it.
 */
export interface HostTerminal {
  /** Inside tmux: $TMUX is set, or TERM names tmux (also true over ssh from a tmux pane). */
  tmux: boolean;
  /** Casper's own tmux pane ($TMUX_PANE, with $TMUX): the only pane Casper splits or sets options on. */
  tmuxPane?: string;
  /** iTerm2 is the terminal: TERM_PROGRAM, or LC_TERMINAL, which ssh and tmux pass along. */
  iterm: boolean;
  /** iTerm2's id for Casper's session ($ITERM_SESSION_ID "w0t0p0:<uuid>"), used to split next to it. */
  itermSession?: string;
  /** How the terminal shows a desktop notification: OSC 9 (iTerm2, WezTerm, Ghostty, kitty) or OSC 777 (foot).
   * Unset: BEL only (Terminal.app, Windows Terminal, Konsole, GNOME Terminal and the rest). */
  notify?: NotifyStyle;
}

export type NotifyStyle = "osc9" | "osc777";

/** The terminal's own notification sequence, from what it sets in the environment. Each one is in that terminal's
 * docs: iTerm2, WezTerm, Ghostty and kitty show OSC 9; foot shows OSC 777 (rxvt's notify). Windows Terminal reads
 * OSC 9 as ConEmu's progress and directory sequences, not a notification, so it gets BEL. Inside tmux TERM_PROGRAM
 * says tmux; the terminal's own variables (KITTY_WINDOW_ID, WEZTERM_PANE, GHOSTTY_RESOURCES_DIR) still say which. */
function notifyStyle(env: Record<string, string | undefined>, iterm: boolean): NotifyStyle | undefined {
  const term = env.TERM ?? "";
  const program = env.TERM_PROGRAM ?? "";
  if (iterm || program === "WezTerm" || program === "ghostty" || term === "xterm-ghostty" || term === "xterm-kitty"
    || env.KITTY_WINDOW_ID || env.WEZTERM_PANE || env.GHOSTTY_RESOURCES_DIR) return "osc9";
  if (term === "foot" || term.startsWith("foot-")) return "osc777";
  return undefined;
}

export function detectHostTerminal(env: Record<string, string | undefined> = process.env): HostTerminal {
  const term = env.TERM ?? "";
  const tmux = Boolean(env.TMUX) || term.startsWith("tmux");
  const iterm = env.TERM_PROGRAM === "iTerm.app" || env.LC_TERMINAL === "iTerm2";
  const itermSession = env.ITERM_SESSION_ID?.split(":").at(-1);
  const notify = notifyStyle(env, iterm);
  return {
    tmux,
    ...(env.TMUX && env.TMUX_PANE && /^%\d+$/.test(env.TMUX_PANE) ? { tmuxPane: env.TMUX_PANE } : {}),
    iterm,
    ...(iterm && itermSession && /^[0-9A-Fa-f-]{8,64}$/.test(itermSession) ? { itermSession } : {}),
    ...(notify ? { notify } : {}),
  };
}

/** Title and notification text: printable, one line, short. */
function oneLine(text: string, max = 80): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** tmux hands a sequence to the outer terminal only inside its passthrough wrapper, with every ESC doubled. */
export function tmuxPassthrough(sequence: string): string {
  return `\x1bPtmux;${sequence.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
}

/**
 * The bell for "done" or "waiting for you". BEL everywhere: tmux marks the window and rings the outer terminal
 * itself. A terminal that shows desktop notifications gets one with it (OSC 9, or OSC 777 in foot), through tmux's
 * passthrough when inside tmux.
 */
export function bellSequence(host: HostTerminal, message: string): string {
  const style = host.notify ?? (host.iterm ? "osc9" : undefined);
  if (!style) return "\x07";
  const text = oneLine(message);
  // OSC 777's fields are split on ";", so the message has none.
  const note = style === "osc9" ? `\x1b]9;${text}\x07` : `\x1b]777;notify;Casper;${text.replaceAll(";", ",")}\x07`;
  return `\x07${host.tmux ? tmuxPassthrough(note) : note}`;
}

/** Save the terminal's title (xterm title stack), so the one it had comes back at exit. */
export const TITLE_SAVE = "\x1b[22;0t";
export const TITLE_RESTORE = "\x1b[23;0t";

/** The window and tab title (OSC 0: macOS Terminal and iTerm2 label the tab from it, not from OSC 2's window
 * title). Inside tmux it is the pane's title, which tmux shows in its own title and borders. */
export function titleSequence(title: string): string {
  return `\x1b]0;${oneLine(title)}\x07`;
}

/** Runs a short helper program (tmux, osascript) by argv, never through a shell. */
export type HostCommand = (argv: readonly string[]) => { status: number | null; stdout: string };

export function hostCommand(env: Record<string, string | undefined> = process.env): HostCommand {
  return (argv) => {
    try {
      const result = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"],
        env: env as NodeJS.ProcessEnv });
      return { status: result.status, stdout: result.stdout ?? "" };
    } catch { return { status: null, stdout: "" }; }
  };
}

/**
 * What Casper sets inside tmux, on its own pane only, and undoes at exit. The outer terminal's notification needs
 * tmux's passthrough (off by default since tmux 3.3), so Casper turns it on for its pane when the pane
 * has no setting of its own. Nothing global, nothing on the user's other panes.
 */
export function prepareTmuxPane(host: HostTerminal, run: HostCommand): () => void {
  if (!host.tmuxPane || !(host.notify ?? host.iterm)) return () => {};
  const pane = host.tmuxPane;
  const own = run(["tmux", "show-options", "-p", "-q", "-v", "-t", pane, "allow-passthrough"]);
  if (own.status !== 0 || own.stdout.trim()) return () => {};
  if (run(["tmux", "set-option", "-p", "-t", pane, "allow-passthrough", "on"]).status !== 0) return () => {};
  let undone = false;
  return () => {
    if (undone) return; undone = true;
    run(["tmux", "set-option", "-p", "-u", "-t", pane, "allow-passthrough"]);
  };
}
