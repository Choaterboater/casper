import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { GRAPH_LIMITS, parseVisualizationGraph, type GraphEdge, type GraphNode, type VisualizationGraph } from "./types";

const IGNORED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", "out", "coverage", ".next", ".turbo", ".cache", "vendor", "target", "__pycache__"]);
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
/**
 * Two-phase matching keeps parsing linear on adversarial input: find quoted specifiers with a
 * backtrack-free scan, then confirm an import/export/require anchor in a bounded window before it.
 */
const QUOTED = /['"]([^'"\n]+)['"]/g;
const ANCHOR = /(?:\bimport\s+(?:[^'";]*?\s+from\s+)?|\bexport\s+(?:\*|\{[^}]*\})\s+from\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)$/;
const ANCHOR_WINDOW = 512;
const MAX_PARSED_FILE_BYTES = 1_048_576;
const READ_CONCURRENCY = 32;

export function extractSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(QUOTED)) {
    const start = match.index!;
    if (ANCHOR.test(source.slice(Math.max(0, start - ANCHOR_WINDOW), start))) specifiers.push(match[1]!);
  }
  return specifiers;
}

export interface RepoGraphOptions {
  root: string;
  /** Subdirectory to scan, relative to root; defaults to the whole project. */
  scope?: string;
  maxFiles?: number;
  /** Collapse to directories when the file graph exceeds this many nodes. */
  maxFileNodes?: number;
  signal?: AbortSignal;
}

export interface RepoGraph {
  graph: VisualizationGraph;
  /** File- or directory-level rendering. */
  granularity: "file" | "directory";
  filesScanned: number;
  truncated: boolean;
  notes: string[];
}

/**
 * Deterministic relative-import dependency graph for JS/TS sources. Read-only; regex based,
 * so dynamic or aliased specifiers are not resolved and are reported as unresolved counts.
 */
export async function buildRepoGraph(options: RepoGraphOptions): Promise<RepoGraph> {
  if (options.signal?.aborted) throw new Error("Visualization cancelled");
  const root = await realpath(options.root);
  const requestedScope = path.resolve(root, options.scope ?? ".");
  const assertInside = (target: string) => {
    const relative = path.relative(root, target);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("Visualization scope must stay inside the project");
    }
  };
  assertInside(requestedScope);
  const scopeDir = await realpath(requestedScope).catch(() => undefined);
  if (!scopeDir) throw new Error(`Visualization scope is not a directory: ${options.scope}`);
  assertInside(scopeDir);
  const relativeScope = path.relative(root, scopeDir);
  const scopeInfo = await stat(scopeDir).catch(() => undefined);
  if (!scopeInfo?.isDirectory()) throw new Error(`Visualization scope is not a directory: ${options.scope}`);
  const maxFiles = options.maxFiles ?? 2000;
  const maxFileNodes = options.maxFileNodes ?? 120;

  const files: string[] = [];
  let truncated = false;
  const walk = async (directory: string): Promise<void> => {
    if (options.signal?.aborted) throw new Error("Visualization cancelled");
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) { truncated = true; return; }
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        // The explicitly requested scope is always scanned; only descendants are filtered.
        if (IGNORED_DIRECTORIES.has(entry.name) || entry.name.startsWith(".")) continue;
        await walk(full);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.includes(path.extname(entry.name)) && !/\.d\.[cm]?ts$/.test(entry.name)) {
        files.push(full);
      }
    }
  };
  await walk(scopeDir);
  if (!files.length) throw new Error("No JavaScript/TypeScript sources found to visualize");

  const fileSet = new Set(files);
  const edgesByFile = new Map<string, Set<string>>();
  let unresolved = 0;
  let external = 0;
  let oversized = 0;
  const parse = async (file: string) => {
    const targets = new Set<string>();
    edgesByFile.set(file, targets);
    const info = await lstat(file);
    if (info.size > MAX_PARSED_FILE_BYTES) { oversized++; return; }
    const source = await readFile(file, "utf8").catch(() => "");
    for (const specifier of extractSpecifiers(source)) {
      if (!specifier.startsWith(".")) { external++; continue; }
      const resolved = resolveRelative(path.dirname(file), specifier, fileSet);
      if (!resolved) { unresolved++; continue; }
      if (resolved !== file) targets.add(resolved);
    }
  };
  for (let index = 0; index < files.length; index += READ_CONCURRENCY) {
    if (options.signal?.aborted) throw new Error("Visualization cancelled");
    await Promise.all(files.slice(index, index + READ_CONCURRENCY).map(parse));
  }

  const notes: string[] = [];
  if (truncated) notes.push(`Scan stopped at ${maxFiles} files; the graph is partial.`);
  if (oversized) notes.push(`${oversized} file(s) over 1 MiB were not parsed for imports.`);
  if (external) notes.push(`${external} package import(s) omitted (only relative imports are drawn).`);
  if (unresolved) notes.push(`${unresolved} relative import(s) could not be resolved to a scanned file.`);

  const label = (file: string) => path.relative(scopeDir, file).split(path.sep).join("/");
  const title = `${path.basename(root)}${relativeScope ? `/${relativeScope.split(path.sep).join("/")}` : ""} module dependencies`;
  if (files.length <= maxFileNodes) {
    const nodes: GraphNode[] = files.map((file) => {
      const relative = label(file);
      const directory = path.posix.dirname(relative);
      return { id: relative, label: relative, ...(directory !== "." ? { group: directory } : {}) };
    });
    const edges: GraphEdge[] = [];
    for (const file of files) for (const target of [...edgesByFile.get(file)!].sort()) edges.push({ from: label(file), to: label(target) });
    return { graph: bound({ type: "dependency-graph", title, nodes, edges }, notes), granularity: "file", filesScanned: files.length, truncated: truncated || notes.some(note => /Only the first|text is truncated/.test(note)), notes };
  }

  // Directory level: nodes are directories relative to scope; edges are deduplicated with counts.
  const directoryOf = (file: string) => { const directory = path.posix.dirname(label(file)); return directory === "." ? "(root)" : directory; };
  const directories = [...new Set(files.map(directoryOf))].sort();
  const counts = new Map<string, number>();
  for (const file of files) {
    for (const target of edgesByFile.get(file)!) {
      const from = directoryOf(file);
      const to = directoryOf(target);
      if (from === to) continue;
      const key = `${from}\u0000${to}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const fileCounts = new Map<string, number>();
  for (const file of files) fileCounts.set(directoryOf(file), (fileCounts.get(directoryOf(file)) ?? 0) + 1);
  const nodes: GraphNode[] = directories.map((directory) => ({ id: directory, label: `${directory} (${fileCounts.get(directory)} files)` }));
  const edges: GraphEdge[] = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, count]) => {
    const [from, to] = key.split("\u0000") as [string, string];
    return { from, to, label: `${count} import${count === 1 ? "" : "s"}` };
  });
  notes.push(`Collapsed ${files.length} files into ${directories.length} directories (file graph exceeds ${maxFileNodes} nodes).`);
  return { graph: bound({ type: "dependency-graph", title, nodes, edges }, notes), granularity: "directory", filesScanned: files.length, truncated: truncated || notes.some(note => /Only the first|text is truncated/.test(note)), notes };
}

function bound(graph: VisualizationGraph, notes: string[]): VisualizationGraph {
  let { nodes, edges } = graph;
  if (nodes.length > GRAPH_LIMITS.maxNodes) {
    notes.push(`Only the first ${GRAPH_LIMITS.maxNodes} of ${nodes.length} nodes are drawn.`);
    nodes = nodes.slice(0, GRAPH_LIMITS.maxNodes);
    const kept = new Set(nodes.map((node) => node.id));
    edges = edges.filter((edge) => kept.has(edge.from) && kept.has(edge.to));
  }
  if (edges.length > GRAPH_LIMITS.maxEdges) {
    notes.push(`Only the first ${GRAPH_LIMITS.maxEdges} of ${edges.length} edges are drawn.`);
    edges = edges.slice(0, GRAPH_LIMITS.maxEdges);
  }
  let shortened = false;
  const shorten = (text: string, limit: number): string => {
    if (Buffer.byteLength(text) <= limit) return text;
    shortened = true;
    let result = "";
    for (const character of text) {
      if (Buffer.byteLength(result + character + "…") > limit) break;
      result += character;
    }
    return result + "…";
  };
  // Preserve ordinary IDs; reserve every original ID before allocating short aliases.
  const used = new Set(nodes.map(node => node.id));
  const ids = new Map<string, string>();
  nodes = nodes.map((node, index) => {
    let id = node.id;
    if (Buffer.byteLength(id) > GRAPH_LIMITS.maxLabelBytes || id !== id.trim()) {
      id = `file-${index}`;
      for (let suffix = 1; used.has(id); suffix++) id = `file-${index}-${suffix}`;
      used.add(id);
      shortened = true;
    }
    ids.set(node.id, id);
    return { ...node, id, label: shorten(node.label, GRAPH_LIMITS.maxLabelBytes),
      ...(node.group !== undefined ? { group: shorten(node.group, GRAPH_LIMITS.maxLabelBytes) } : {}),
      ...(node.note !== undefined ? { note: shorten(node.note, GRAPH_LIMITS.maxNoteBytes) } : {}) };
  });
  edges = edges.map(edge => ({ ...edge, from: ids.get(edge.from)!, to: ids.get(edge.to)!,
    ...(edge.label !== undefined ? { label: shorten(edge.label, GRAPH_LIMITS.maxLabelBytes) } : {}) }));
  const title = shorten(graph.title, GRAPH_LIMITS.maxTitleBytes);
  if (shortened) notes.push("Graph text was shortened and oversized IDs remapped to meet IR byte limits; text is truncated.");
  return parseVisualizationGraph({ ...graph, title, nodes, edges });
}

function resolveRelative(fromDir: string, specifier: string, files: Set<string>): string | undefined {
  const base = path.resolve(fromDir, specifier);
  const candidates = [base];
  const extension = path.extname(base);
  // TypeScript sources may import ".js" siblings that exist only as ".ts".
  if ([".js", ".mjs", ".cjs", ".jsx"].includes(extension)) {
    const stem = base.slice(0, -extension.length);
    candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`);
  }
  for (const ext of SOURCE_EXTENSIONS) candidates.push(`${base}${ext}`);
  for (const ext of SOURCE_EXTENSIONS) candidates.push(path.join(base, `index${ext}`));
  return candidates.find((candidate) => files.has(candidate));
}
