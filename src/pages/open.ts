import { browserCommand } from "../tui/login";

/** Whether a browser on this computer can show a page to the person: not over SSH (the browser would open on the
 * far machine, or not at all), not in CI, and on Linux only with a display. */
export function desktopHere(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): boolean {
  if (env.CI && env.CI !== "0" && env.CI.toLowerCase() !== "false") return false;
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return false;
  if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
  return true;
}

/** Opens a local page address in the default browser (macOS open, Windows' URL handler, xdg-open elsewhere: the
 * same commands /login uses). False when the program could not start. */
export function openInBrowser(url: string): boolean {
  try {
    const child = Bun.spawn(browserCommand(url), { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    child.unref();
    return true;
  } catch { return false; }
}
