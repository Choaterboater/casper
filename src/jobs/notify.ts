/**
 * The desktop notification a walk-away job sends when it ends or needs you: macOS Notification Center through
 * osascript, or notify-send on Linux when it is installed. Nothing on Windows (a job there can't outlive its window).
 * Run by argv, never through a shell; the words are one printable line.
 */
import { spawn } from "node:child_process";

export type NotifyRun = (argv: readonly string[]) => Promise<boolean>;

const run: NotifyRun = (argv) => new Promise((resolve) => {
  try {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: "ignore", detached: false });
    const timer = setTimeout(() => { child.kill(); resolve(false); }, 5_000);
    child.once("error", () => { clearTimeout(timer); resolve(false); });
    child.once("exit", (code) => { clearTimeout(timer); resolve(code === 0); });
  } catch { resolve(false); }
});

export function notificationText(text: string, max = 180): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** The program and its arguments for one notification, or undefined where Casper has none to use. */
export function notifyCommand(message: string, platform: NodeJS.Platform = process.platform, which: (name: string) => string | null = Bun.which): string[] | undefined {
  const text = notificationText(message);
  if (!text) return undefined;
  if (platform === "darwin") {
    const osascript = which("osascript");
    // The words are an argument of the script, never part of it: nothing in them can end a quote.
    return osascript ? [osascript, "-e", "on run argv", "-e", "display notification (item 1 of argv) with title \"Casper\"", "-e", "end run", text] : undefined;
  }
  if (platform === "linux") {
    const notifySend = which("notify-send");
    return notifySend ? [notifySend, "--app-name=Casper", "Casper", text] : undefined;
  }
  return undefined;
}

/** True when a notification was shown. */
export async function desktopNotify(message: string, options: { platform?: NodeJS.Platform; which?: (name: string) => string | null; run?: NotifyRun } = {}): Promise<boolean> {
  const argv = notifyCommand(message, options.platform, options.which);
  return argv ? (options.run ?? run)(argv) : false;
}
