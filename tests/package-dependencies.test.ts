import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");

test("every engine package imported by src is declared with an exact version", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { dependencies: Record<string, string> };
  const imported = new Set<string>();
  for (const file of await readdir(path.join(root, "src"), { recursive: true })) {
    if (!file.endsWith(".ts")) continue;
    const source = await readFile(path.join(root, "src", file), "utf8");
    // Static, type-only and dynamic imports; a subpath (`pi-ai/compat`) names its package.
    for (const match of source.matchAll(/(?:from\s+|import\s*\(\s*)["'](@earendil-works\/[a-z0-9-]+)/g)) imported.add(match[1]!);
  }
  expect([...imported].sort()).toContain("@earendil-works/pi-coding-agent");
  // A hoisted transitive package floats with pi-coding-agent's caret range on every lock refresh.
  const declared = Object.fromEntries([...imported].sort().map((name) => [name, manifest.dependencies[name]]));
  const pinned = manifest.dependencies["@earendil-works/pi-coding-agent"];
  expect(declared).toEqual(Object.fromEntries([...imported].sort().map((name) => [name, pinned])));
  expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
});
