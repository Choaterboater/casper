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

/** Candidate executables in preference order for one platform and environment. */
export function browserCandidates(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform === "darwin") return [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ];
  if (platform === "win32") return WINDOWS_BROWSER_LOCATIONS.flatMap(([variable, relative]) => {
    const root = env[variable];
    return root ? [path.join(root, relative)] : [];
  });
  return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"];
}

/** First installed browser, or undefined when none is found. Never downloads one. */
export async function discoverBrowser(supplied?: string): Promise<string | undefined> {
  if (supplied) return supplied;
  for (const candidate of browserCandidates()) {
    try { await access(candidate); return candidate; } catch { /* try the next location */ }
  }
  return undefined;
}