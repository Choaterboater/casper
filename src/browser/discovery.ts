import { readFileSync } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";

/**
 * Installed-browser locations per platform. A supplied CASPER_BROWSER_EXECUTABLE
 * or options.executablePath always wins over discovery.
 */
const WINDOWS_BROWSER_LOCATIONS: Array<[string, string]> = [
  ["ProgramFiles", "Google\\Chrome\\Application\\chrome.exe"],
  ["ProgramFiles(x86)", "Google\\Chrome\\Application\\chrome.exe"],
  ["LOCALAPPDATA", "Google\\Chrome\\Application\\chrome.exe"],
  ["ProgramFiles", "Microsoft\\Edge\\Application\\msedge.exe"],
  ["ProgramFiles(x86)", "Microsoft\\Edge\\Application\\msedge.exe"],
];

const LINUX_BROWSER_LOCATIONS = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome", "/usr/bin/chromium",
  "/usr/bin/chromium-browser", "/snap/bin/chromium", "/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable"];
const LINUX_BROWSER_NAMES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable"];

/** WSL: Linux on Windows. Its Windows programs (/mnt/c/…/chrome.exe) can't be driven: Casper talks to Chrome over pipes,
 * which a Windows program can't use from WSL, and Chrome there can't keep its profile on WSL's disk. */
export function isWsl(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env, kernel?: string): boolean {
  if (platform !== "linux") return false;
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  let version = kernel;
  if (version === undefined) { try { version = readFileSync("/proc/version", "utf8"); } catch { version = ""; } }
  return /microsoft|wsl/i.test(version);
}

/** For the person, under WSL: where the browser has to be and how to get it. Empty elsewhere. */
export function wslBrowserHint(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env, kernel?: string): string {
  return isWsl(platform, env, kernel) ? " On WSL that means one inside WSL, not the Windows Chrome: wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && sudo apt install -y ./google-chrome-stable_current_amd64.deb" : "";
}

const GENERIC_UNAVAILABLE = "Browser unavailable: install Chrome yourself or set CASPER_BROWSER_EXECUTABLE to an absolute executable path";
/** What a browser action says when no browser is found: on WSL, how to get one there. */
export function browserUnavailable(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env, kernel?: string): string {
  if (!isWsl(platform, env, kernel)) return GENERIC_UNAVAILABLE;
  return "Browser unavailable: this is WSL, and Casper drives a Chrome inside WSL, not the Windows one under /mnt/c. "
    + "Install it in WSL: wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && sudo apt install -y ./google-chrome-stable_current_amd64.deb "
    + "(or set CASPER_BROWSER_EXECUTABLE). Don't start the Windows Chrome yourself; tell the user.";
}

/** Candidate executables in preference order for one platform and environment. On Linux, a browser on PATH too. */
export function browserCandidates(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env,
  which: (name: string) => string | null | undefined = (name) => Bun.which(name, { PATH: env.PATH ?? "" })): string[] {
  if (platform === "darwin") return [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ];
  if (platform === "win32") return WINDOWS_BROWSER_LOCATIONS.flatMap(([variable, relative]) => {
    const root = env[variable];
    return root ? [path.join(root, relative)] : [];
  });
  // A browser on PATH, but never a Windows one reached through WSL's /mnt drives.
  const onPath = LINUX_BROWSER_NAMES.map((name) => which(name)).filter((found): found is string => Boolean(found) && path.isAbsolute(found!) && !found!.startsWith("/mnt/"));
  return [...new Set([...LINUX_BROWSER_LOCATIONS, ...onPath])];
}

/** First installed browser, or undefined when none is found. Never downloads one. */
export async function discoverBrowser(supplied?: string): Promise<string | undefined> {
  if (supplied) return supplied;
  for (const candidate of browserCandidates()) {
    try { await access(candidate); return candidate; } catch { /* try the next location */ }
  }
  return undefined;
}

/** Whether a browser is really on this machine (a supplied path must exist too). */
async function browserInstalled(): Promise<boolean> {
  const found = await discoverBrowser(process.env.CASPER_BROWSER_EXECUTABLE);
  if (!found || !path.isAbsolute(found)) return false;
  try { await access(found); return true; } catch { return false; }
}

/** How a session learns that a browser is installed; the test suite swaps it for a fixed answer. */
export const browserDefaults: { installed: () => Promise<boolean> } = { installed: browserInstalled };
