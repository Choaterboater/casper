/**
 * macOS bundles (an .app and the bundles inside one): signed as a whole, so adding or changing any file in one breaks
 * its code signature and macOS may refuse to open it. The AI's edit and write tools ask before a write there, even when
 * Casper was started in the bundle and it is the project.
 */

import { existsSync, statSync } from "node:fs";
import path from "node:path";

const BUNDLE = /\.(?:app|appex|xpc|bundle|plugin|kext|framework)$/i;

function isDirectory(file: string): boolean {
  try { return statSync(file).isDirectory(); } catch { return false; }
}

/** The outermost bundle `absolute` is in or is ("/Applications/Iris.app"), or undefined. A folder only counts when it is
 * built like one (Contents/ inside it, or Versions/ or Resources/ for a framework), so a folder named "site.app" in a
 * web project doesn't. */
export function signedBundle(absolute: string): string | undefined {
  const parts = path.resolve(absolute).split(path.sep);
  for (let end = 1; end <= parts.length; end++) {
    const name = parts[end - 1]!;
    if (!BUNDLE.test(name)) continue;
    const folder = parts.slice(0, end).join(path.sep) || path.sep;
    if (!isDirectory(folder)) continue;
    const framework = /\.framework$/i.test(name);
    if (existsSync(path.join(folder, "Contents")) || (framework && (existsSync(path.join(folder, "Versions")) || existsSync(path.join(folder, "Resources"))))) return folder;
  }
  return undefined;
}
