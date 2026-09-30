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
}

export function detectHostTerminal(env: Record<string, string | undefined> = process.env): HostTerminal {
  const term = env.TERM ?? "";
  const tmux = Boolean(env.TMUX) || term.startsWith("tmux");
  const iterm = env.TERM_PROGRAM === "iTerm.app" || env.LC_TERMINAL === "iTerm2";
  const itermSession = env.ITERM_SESSION_ID?.split(":").at(-1);
  return {
    tmux,
    ...(env.TMUX && env.TMUX_PANE && /^%\d+$/.test(env.TMUX_PANE) ? { tmuxPane: env.TMUX_PANE } : {}),
    iterm,
    ...(iterm && itermSession && /^[0-9A-Fa-f-]{8,64}$/.test(itermSession) ? { itermSession } : {}),
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
 * The bell for "done" or "waiting for you". BEL alone everywhere: tmux marks the window and rings the outer
 * terminal itself. In iTerm2 a notification goes with it (OSC 9), through tmux's passthrough when inside tmux.
 */
export function bellSequence(host: HostTerminal, message: string): string {
  if (!host.iterm) return "\x07";
  const note = `\x1b]9;${oneLine(message)}\x07`;
  return `\x07${host.tmux ? tmuxPassthrough(note) : note}`;
}

/** Save the terminal's title (xterm title stack), so the one it had comes back at exit. */
export const TITLE_SAVE = "\x1b[22;0t";
export const TITLE_RESTORE = "\x1b[23;0t";

/** The window title (OSC 2). Inside tmux it is the pane's title, which tmux shows in its own title and borders. */
export function titleSequence(title: string): string {
  return `\x1b]2;${oneLine(title)}\x07`;
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
 * What Casper sets inside tmux, on its own pane only, and undoes at exit. iTerm2's notification needs
 * tmux's passthrough (off by default since tmux 3.3), so Casper turns it on for its pane when the pane
 * has no setting of its own. Nothing global, nothing on the user's other panes.
 */
export function prepareTmuxPane(host: HostTerminal, run: HostCommand): () => void {
  if (!host.tmuxPane || !host.iterm) return () => {};
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
