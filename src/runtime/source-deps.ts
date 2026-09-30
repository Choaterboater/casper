import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * From source, Casper runs on the packages `bun install` put in node_modules. After a pull that adds or
 * changes one, a plain start would fail with a module error, so the launcher checks first: every package in
 * package.json's dependencies is installed, at the pinned version when package.json pins one. It reads only
 * small package.json files and uses only built-in modules, so it runs before any package is loaded.
 */
export function staleDependencies(repo: string): string[] {
  let manifest: { dependencies?: Record<string, string> };
  try { manifest = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8")); } catch { return []; }
  const stale: string[] = [];
  for (const [name, wanted] of Object.entries(manifest.dependencies ?? {})) {
    let installed: string | undefined;
    try { installed = JSON.parse(readFileSync(path.join(repo, "node_modules", name, "package.json"), "utf8")).version; } catch { /* not installed */ }
    const pinned = /^\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/.test(wanted);
    if (!installed || (pinned && installed !== wanted)) stale.push(name);
  }
  return stale;
}

/** The one line the launcher prints (then exits 1) when the checkout needs `bun install`. */
export function sourceDependencyProblem(repo: string): string | undefined {
  return staleDependencies(repo).length ? `New parts were added. Run: bun install  (in ${repo})` : undefined;
}
