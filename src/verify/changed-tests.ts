import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { isOutside } from "../platform/inside";

/** Only known Bun test entrypoints: never reinterpret an arbitrary custom runner or shell pipeline. */
export function hasChangedTestPhase(command: string | undefined): boolean {
  return Boolean(command && /^(?:bun test|bun (?:run )?(?:\.\/)?\.casper\/quick-test\.ts)$/.test(command.trim()));
}

const TEST = /(?:^|[./])[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/;
const CODE = /\.[cm]?[jt]sx?$/;
const OMIT = new Set(["node_modules", ".git", ".casper", "dist", "build", "coverage", "fixtures"]);

/** Literal import graph, including re-exports, require and dynamic imports. No test or project code is executed.
 * Unknown/oversized graphs defer to the final configured command, never silently run a broad suite mid-change. */
export async function changedTestFiles(root: string, changed: readonly string[] | undefined, signal?: AbortSignal): Promise<string[] | undefined> {
  if (!changed) return undefined;
  const base = await realpath(root).catch(() => undefined);
  if (!base) return undefined;
  const inside = (file: string) => !isOutside(path.relative(base, file));
  const identity = async (file: string) => realpath(file).catch(() => path.resolve(file));
  const targets = new Set(await Promise.all(changed.map(file => identity(path.resolve(base, file)))));
  const tests: string[] = [];
  let files = 0, bytes = 0;
  const deadline = performance.now() + 5_000;
  const guard = () => {
    if (signal?.aborted || ++files > 20_000 || performance.now() > deadline) throw new Error("Import graph unavailable");
  };
  try {
    const visit = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        guard();
        if (OMIT.has(entry.name) || entry.name.startsWith(".")) continue;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) await visit(file);
        else if (entry.isFile() && TEST.test(file.split(path.sep).join("/"))) tests.push(file);
      }
    };
    await visit(base);
    const graph = new Map<string, string[]>();
    const load = async (file: string): Promise<void> => {
      guard();
      if (graph.has(file) || !inside(file) || !CODE.test(file)) return;
      graph.set(file, []); // cycles
      const stat = await lstat(file).catch(() => undefined);
      if (!stat?.isFile()) return;
      if (stat.size > 2_000_000 || (bytes += stat.size) > 64_000_000) throw new Error("Import graph too large");
      const source = await readFile(file, "utf8");
      const loader = /\.[cm]?tsx?$/.test(file) ? "tsx" : "jsx";
      const imports = new Bun.Transpiler({ loader }).scanImports(source);
      for (const spec of imports) {
        if (spec.path.startsWith("node:") || spec.path === "bun" || spec.path.startsWith("bun:")) continue;
        let resolved: string;
        try { resolved = Bun.resolveSync(spec.path, path.dirname(file)); }
        catch {
          if (!spec.path.startsWith(".")) continue;
          // Deleted sources must still select their importers.
          const stem = path.resolve(path.dirname(file), spec.path);
          graph.get(file)!.push(...[stem, ...[".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.js"].map(ext => stem + ext)]);
          continue;
        }
        resolved = await identity(resolved);
        if (!inside(resolved) || resolved.split(path.sep).includes("node_modules")) continue;
        graph.get(file)!.push(resolved);
        await load(resolved);
      }
    };
    for (const file of tests) await load(file);
    const affected = (file: string, seen = new Set<string>()): boolean => {
      if (targets.has(file)) return true;
      if (seen.has(file)) return false;
      seen.add(file);
      return (graph.get(file) ?? []).some(dependency => affected(dependency, seen));
    };
    return tests.filter(file => affected(file)).map(file => path.relative(base, file).split(path.sep).join("/")).sort();
  } catch { return undefined; }
}
