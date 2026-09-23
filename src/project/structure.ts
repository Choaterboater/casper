import { lstat } from "node:fs/promises";
import path from "node:path";

/** Known UI, style, and design locations. Existence only — no file contents, no skill. */
const UI_DIRECTORIES = ["src/components", "components", "app/components", "src/ui", "src/pages", "pages"];
const STYLE_FILES = [
  "tailwind.config.ts", "tailwind.config.js", "tailwind.config.mjs", "tailwind.config.cjs",
  "postcss.config.js", "postcss.config.mjs", "postcss.config.cjs",
  "src/index.css", "src/styles.css", "src/app/globals.css", "app/globals.css",
  "styles/globals.css", "src/styles/globals.css",
  "tokens.css", "tokens.json", "design-tokens.json", "design-tokens.css",
  "src/styles/tokens.css", "src/styles/tokens.json",
];
const DESIGN_DIRECTORIES = ["design", "design-system", "src/design", "src/design-system"];

export const STRUCTURE_PROBES = [...UI_DIRECTORIES, ...STYLE_FILES, ...DESIGN_DIRECTORIES];

async function isKind(root: string, relative: string, kind: "file" | "dir"): Promise<boolean> {
  try {
    const stats = await lstat(path.join(root, relative));
    if (stats.isSymbolicLink()) return false;
    return kind === "dir" ? stats.isDirectory() : stats.isFile();
  } catch {
    return false;
  }
}

/** Bounded locations already in the repository. This replaces a frontend or design skill. */
export async function detectRepositoryStructure(root: string): Promise<{
  architecture: Record<string, string>;
  conventions: string[];
}> {
  const ui: string[] = [];
  for (const relative of UI_DIRECTORIES) if (await isKind(root, relative, "dir")) ui.push(relative);
  const styles: string[] = [];
  for (const relative of STYLE_FILES) if (await isKind(root, relative, "file")) styles.push(relative);
  const design: string[] = [];
  for (const relative of DESIGN_DIRECTORIES) if (await isKind(root, relative, "dir")) design.push(relative);

  const architecture: Record<string, string> = {};
  if (ui.length) architecture.ui = ui.join(", ");
  if (styles.length) architecture.styles = styles.join(", ");
  if (design.length) architecture.design = design.join(", ");
  return {
    architecture,
    conventions: Object.keys(architecture).length
      ? ["Match the existing UI and styles in this repository. Do not add a frontend skill, design skill, or a new design system unless the request asks for one."]
      : [],
  };
}
