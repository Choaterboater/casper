import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MermaidProvider } from "../src/visualize/mermaid";
import { MindMeshProvider, MINDMESH_SCHEMA_VERSION, toMindMeshMap } from "../src/visualize/mindmesh";
import { buildRepoGraph } from "../src/visualize/repo";
import { resolveVisualizationSettings, VisualizationRouter } from "../src/visualize/router";
import { describeVisualization, visualizationTools } from "../src/visualize/tools";
import { GRAPH_LIMITS, parseVisualizationGraph, spanningTree, type VisualizationGraph, type VisualizationProvider } from "../src/visualize/types";
import { classifyTask } from "../src/task/classify";
import { needsSymlinks } from "./support/platform";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const authFlow: VisualizationGraph = {
  type: "flowchart", title: "Authentication flow",
  nodes: [
    { id: "ui", label: "Login UI", group: "web" },
    { id: "api", label: "Auth API", group: "server" },
    { id: "db", label: "User store", group: "server", note: "hashed passwords" },
    { id: "session", label: "Session cookie", group: "web" },
  ],
  edges: [
    { from: "ui", to: "api", label: "POST /login" },
    { from: "api", to: "db", label: "verify" },
    { from: "api", to: "session", label: "set-cookie" },
    { from: "session", to: "ui" },
  ],
};

/**
 * Structural mirror of MindMesh's `validateMap` (packages/map-model/src/invariants.ts) so this
 * suite proves the emitted document is tree-valid without importing MindMesh code.
 */
function mindmeshInvariants(map: { rootId: string; nodes: Record<string, { id: string; parentId: string | null; childIds: string[] }> }): string[] {
  const issues: string[] = [];
  const root = map.nodes[map.rootId];
  if (!root) return ["missing_root"];
  if (root.parentId !== null) issues.push("root_has_parent");
  for (const node of Object.values(map.nodes)) {
    const seen = new Set<string>();
    for (const child of node.childIds) {
      if (seen.has(child)) issues.push(`duplicate_child:${child}`);
      seen.add(child);
      const target = map.nodes[child];
      if (!target) { issues.push(`dangling_child:${child}`); continue; }
      if (target.parentId !== node.id) issues.push(`parent_mismatch:${child}`);
    }
  }
  const reachable = new Set<string>();
  const stack = [map.rootId];
  while (stack.length) {
    const id = stack.pop()!;
    if (reachable.has(id)) { issues.push(`cycle:${id}`); continue; }
    reachable.add(id);
    for (const child of map.nodes[id]?.childIds ?? []) if (map.nodes[child]) stack.push(child);
  }
  for (const id of Object.keys(map.nodes)) if (!reachable.has(id)) issues.push(`orphan_node:${id}`);
  return issues;
}

test("graph IR rejects malformed, oversized, and dangling input; accepts normalized graphs", () => {
  expect(parseVisualizationGraph(authFlow)).toEqual(authFlow);
  expect(() => parseVisualizationGraph(null)).toThrow("expected an object");
  expect(() => parseVisualizationGraph({ ...authFlow, type: "gantt" })).toThrow("type must be one of");
  expect(() => parseVisualizationGraph({ ...authFlow, extra: 1 })).toThrow("unknown fields extra");
  expect(() => parseVisualizationGraph({ ...authFlow, nodes: [] })).toThrow("nonempty");
  expect(() => parseVisualizationGraph({ ...authFlow, nodes: [...authFlow.nodes, { id: "ui", label: "dup" }] })).toThrow("duplicate node id");
  expect(() => parseVisualizationGraph({ ...authFlow, edges: [{ from: "ui", to: "ghost" }] })).toThrow("unknown node \"ghost\"");
  expect(() => parseVisualizationGraph({ ...authFlow, nodes: [{ id: "a", label: "x".repeat(GRAPH_LIMITS.maxLabelBytes + 1) }], edges: [] })).toThrow("exceeds");
  expect(() => parseVisualizationGraph({ ...authFlow, nodes: [{ id: "a", label: "A", color: "red" }], edges: [] })).toThrow("unknown fields color");
  const big = { type: "plan", title: "Big", nodes: Array.from({ length: GRAPH_LIMITS.maxNodes + 1 }, (_, i) => ({ id: `n${i}`, label: `N${i}` })), edges: [] };
  expect(() => parseVisualizationGraph(big)).toThrow(`more than ${GRAPH_LIMITS.maxNodes} nodes`);
  // Whitespace is trimmed; edges default to empty.
  expect(parseVisualizationGraph({ type: "mindmap", title: "  T ", nodes: [{ id: " a ", label: " A " }] })).toEqual({ type: "mindmap", title: "T", nodes: [{ id: "a", label: "A" }], edges: [] });
});

test("spanning tree is deterministic: natural root, synthetic root for forests/cycles, cross edges preserved", () => {
  // authFlow is fully cyclic (session → ui), so no zero-in-degree node exists; the highest fan-out node wins.
  const cyclic = spanningTree(authFlow);
  expect(cyclic.rootId).toBe("api");
  expect(cyclic.syntheticRoot).toBe(false);
  expect([...cyclic.children.entries()]).toEqual([["api", ["db", "session"]], ["session", ["ui"]]]);
  expect(cyclic.crossEdges).toEqual([{ from: "ui", to: "api", label: "POST /login" }]);

  const acyclic: VisualizationGraph = { ...authFlow, edges: authFlow.edges.slice(0, 3) };
  const single = spanningTree(acyclic);
  expect(single.rootId).toBe("ui");
  expect(single.syntheticRoot).toBe(false);
  expect([...single.children.entries()]).toEqual([["ui", ["api"]], ["api", ["db", "session"]]]);
  expect(single.crossEdges).toEqual([]);

  const forest = spanningTree({ type: "mindmap", title: "F", nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }], edges: [{ from: "a", to: "c" }] });
  expect(forest.syntheticRoot).toBe(true);
  expect(forest.children.get("__root__")).toEqual(["a", "b"]);
  expect(forest.children.get("a")).toEqual(["c"]);

  const cycle = spanningTree({ type: "mindmap", title: "C", nodes: [{ id: "x", label: "X" }, { id: "y", label: "Y" }], edges: [{ from: "x", to: "y" }, { from: "y", to: "x" }] });
  expect(cycle.rootId).toBe("x");
  expect(cycle.syntheticRoot).toBe(false);
  expect(cycle.crossEdges).toEqual([{ from: "y", to: "x" }]);

  // A natural root plus an unreachable island still draws every node.
  const island = spanningTree({ type: "mindmap", title: "I", nodes: [{ id: "r", label: "R" }, { id: "k", label: "K" }, { id: "i", label: "I" }, { id: "j", label: "J" }], edges: [{ from: "r", to: "k" }, { from: "i", to: "j" }, { from: "j", to: "i" }] });
  expect(island.syntheticRoot).toBe(true);
  expect(island.children.get("__root__")).toEqual(["r", "i"]);
});

test("Mermaid flowchart escapes labels, groups subgraphs, and labels edges", async () => {
  const graph = parseVisualizationGraph({ ...authFlow, nodes: [...authFlow.nodes, { id: "odd", label: 'say "hi" #1 | x\nnewline', group: "web" }], edges: [...authFlow.edges, { from: "odd", to: "ui", label: 'a|b "c" #' }] });
  const result = await new MermaidProvider().render(graph);
  expect(result.format).toBe("mmd");
  expect(result.content).toContain("flowchart TD");
  expect(result.content).toContain('subgraph g0 ["web"]');
  expect(result.content).toContain('subgraph g1 ["server"]');
  expect(result.content).toContain('n0["Login UI"]');
  expect(result.content).toContain('n4["say #quot;hi#quot; #35;1 | x newline"]');
  expect(result.content).toContain("n0 -->|POST /login| n1");
  expect(result.content).toContain("n4 -->|a#124;b #quot;c#quot; #35;| n0");
  expect(result.content).not.toMatch(/\n[^\n]*"[^\n]*"[^\n]*"[^\n]*"[^\n]*\n/); // no stray unescaped quotes inside a label line
  expect(result.lossiness).toEqual(["Node notes are not drawn in Mermaid flowcharts."]);
  const lr = await new MermaidProvider().render({ ...authFlow, type: "architecture" });
  expect(lr.content).toContain("flowchart LR");
});

test("Mermaid mindmap projects a tree, strips shape characters, and discloses cross edges", async () => {
  const graph: VisualizationGraph = { type: "mindmap", title: "Casper (core)", nodes: [
    { id: "core", label: "Casper [core]" }, { id: "mcp", label: "MCP (broker)", group: "capabilities" }, { id: "lsp", label: "LSP" }, { id: "pi", label: "Pi runtime" },
  ], edges: [{ from: "core", to: "mcp" }, { from: "core", to: "lsp" }, { from: "mcp", to: "pi" }, { from: "lsp", to: "pi", label: "shares" }] };
  const result = await new MermaidProvider().render(graph);
  expect(result.content).toBe([
    "---", 'title: "Casper (core)"', "---", "mindmap",
    "  root((Casper core))",
    "    MCP broker",
    "      Pi runtime",
    "    LSP",
    "%% cross edge: LSP -> Pi runtime (shares)",
    "",
  ].join("\n"));
  expect(result.lossiness).toEqual([
    "1 cross edge(s) cannot be drawn in a mindmap; listed as comments.",
    "Groups are not represented in mindmaps.",
    "Shape and comment characters were removed from mindmap labels.",
  ]);
});

test("MindMesh provider emits a schema-6 tree document that satisfies MindMesh invariants", async () => {
  const provider = new MindMeshProvider({ now: () => "2026-01-01T00:00:00.000Z", mapId: () => "map1" });
  const result = await provider.render(authFlow);
  expect(result.format).toBe("json");
  const map = JSON.parse(result.content);
  expect(map.schemaVersion).toBe(MINDMESH_SCHEMA_VERSION);
  expect(map.id).toBe("map1");
  expect(map.title).toBe("Authentication flow");
  expect(map.layout).toBe("rightward");
  expect(map.nodeAppearance).toBe("boxed");
  expect(map.colorScheme).toBe("teal");
  expect(map.meta).toEqual({ createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });
  expect(mindmeshInvariants(map)).toEqual([]);
  expect(Object.keys(map.nodes)).toHaveLength(4);
  // Cyclic input: the tree hangs from the highest fan-out node; the closing edge survives as a cross edge.
  expect(map.rootId).toBe("map1:api");
  expect(map.nodes["map1:api"]).toMatchObject({ parentId: null, childIds: ["map1:db", "map1:session"], text: "Auth API" });
  expect(map.nodes["map1:api"].extensions.casper).toEqual({ graphId: "api", graphType: "flowchart", group: "server", crossEdgesIn: [{ from: "ui", label: "POST /login" }] });
  expect(map.nodes["map1:api"].note).toBe("← Login UI (POST /login)");
  expect(map.nodes["map1:db"].extensions.casper.edgeLabel).toBe("verify");
  expect(map.nodes["map1:db"].note).toBe("hashed passwords");
  expect(map.nodes["map1:ui"]).toMatchObject({ parentId: "map1:session", childIds: [], text: "Login UI", note: "→ Auth API (POST /login)" });
  expect(map.nodes["map1:ui"].extensions.casper).toEqual({ graphId: "ui", group: "web", crossEdgesOut: [{ to: "api", label: "POST /login" }] });
  expect(result.lossiness).toEqual([
    "1 cross edge(s) are recorded in node notes/extensions, not drawn as branches.",
    "Groups are recorded in node extensions, not drawn.",
    "Edge labels are recorded in node extensions only.",
  ]);
});

test("MindMesh synthetic root cannot collide with graph ids and keeps every node reachable", () => {
  const graph: VisualizationGraph = { type: "mindmap", title: "Forest", nodes: [
    { id: "root", label: "user-chosen root id" }, { id: "map1:root", label: "hostile id" }, { id: "solo", label: "Solo" }, { id: "leaf", label: "Leaf" },
  ], edges: [{ from: "root", to: "leaf" }, { from: "map1:root", to: "leaf" }] };
  const map = toMindMeshMap(graph, "map1", "2026-01-01T00:00:00.000Z");
  expect(map.rootId).toBe("map1: root");
  // Graph ids are trimmed, so no user id can produce the synthetic root's reserved ": root" shape;
  // both "root" and "map1:root" land under the namespace as ordinary children.
  expect(map.nodes["map1: root"]).toMatchObject({ parentId: null, text: "Forest", childIds: ["map1:root", "map1:map1:root", "map1:solo"] });
  expect(map.nodes["map1:root"]).toMatchObject({ parentId: "map1: root", text: "user-chosen root id", childIds: ["map1:leaf"] });
  expect(mindmeshInvariants(map)).toEqual([]);
  expect(Object.keys(map.nodes)).toHaveLength(5);
  expect(map.layout).toBe("balanced");
  expect(map.nodes["map1: root"]!.extensions!.casper).toMatchObject({ syntheticRoot: true, graphType: "mindmap" });
});

test("router renders configured providers in order, writes artifacts outside the workspace, and never overwrites", async () => {
  const out = await tempDir("casper-viz-out-");
  let tick = 0;
  const router = new VisualizationRouter({ workspaceRoot: await tempDir("casper-viz-workspace-"),
    providers: [new MermaidProvider(), new MindMeshProvider({ now: () => "2026-01-01T00:00:00.000Z" })],
    settings: { providers: ["mindmesh", "mermaid", "graphviz"], outputDir: path.join(out, "nested", "dir") },
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
  });
  expect(router.diagnostics).toEqual(['Unknown visualization provider "graphviz" ignored']);
  expect(router.providerNames()).toEqual(["mindmesh", "mermaid"]);
  const rendered = await router.render(authFlow);
  expect(rendered.primary.provider).toBe("mindmesh");
  expect(rendered.artifacts.map((artifact) => path.basename(artifact.path))).toEqual([
    "2026-01-01T00-00-00-000Z-authentication-flow.mindmesh.json",
    "2026-01-01T00-00-00-000Z-authentication-flow.mermaid.mmd",
  ]);
  expect(await readFile(rendered.artifacts[1]!.path, "utf8")).toBe((await new MermaidProvider().render(authFlow)).content);
  const second = await router.render(authFlow);
  expect(await readdir(path.join(out, "nested", "dir"))).toHaveLength(4);
  expect(second.artifacts[0]!.path).not.toBe(rendered.artifacts[0]!.path);
  tick = 0; // same timestamp again → exclusive create keeps the originals and suffixes the new files
  const third = await router.render(authFlow);
  expect(third.artifacts.map((artifact) => path.basename(artifact.path))).toEqual([
    "2026-01-01T00-00-00-000Z-authentication-flow-2.mindmesh.json",
    "2026-01-01T00-00-00-000Z-authentication-flow-2.mermaid.mmd",
  ]);
  expect(await readFile(rendered.artifacts[1]!.path, "utf8")).toBe((await new MermaidProvider().render(authFlow)).content);

  const disabled = new VisualizationRouter({ workspaceRoot: await tempDir("casper-viz-workspace-"), providers: [new MermaidProvider()], settings: { providers: ["mermaid"], outputDir: null } });
  const inline = await disabled.render(authFlow);
  expect(inline.artifacts).toEqual([]);
  expect(describeVisualization(inline).notes).toEqual([
    "No artifact written (visualize.outputDir disabled); content is in-conversation only.",
    "Visualization is read-only; it does not authorize code changes.",
  ]);
  expect(() => new VisualizationRouter({ workspaceRoot: out, providers: [new MermaidProvider()], settings: { providers: ["nope"], outputDir: null } })).toThrow("No usable visualization providers");

  const picky: VisualizationProvider = { name: "picky", supports: (type) => type === "plan", render: async () => ({ provider: "picky", format: "txt", mimeType: "text/plain", content: "p", lossiness: [] }) };
  const mixed = new VisualizationRouter({ workspaceRoot: await tempDir("casper-viz-workspace-"), providers: [picky, new MermaidProvider()], settings: { providers: ["picky", "mermaid"], outputDir: null } });
  const fell = await mixed.render(authFlow);
  expect(fell.primary.provider).toBe("mermaid");
  expect(fell.skipped).toEqual(["picky"]);
  const only = new VisualizationRouter({ workspaceRoot: await tempDir("casper-viz-workspace-"), providers: [picky], settings: { providers: ["picky"], outputDir: null } });
  await expect(only.render(authFlow)).rejects.toThrow("No configured provider supports flowchart");
  const aborted = new AbortController();
  aborted.abort();
  await expect(mixed.render(authFlow, aborted.signal)).rejects.toThrow("Visualization cancelled");
});

test("visualization settings: defaults outside the workspace, tilde expansion, project may only disable", () => {
  const home = "/tmp/casper-home";
  const base = { projectName: "My Repo!", homeDir: home };
  expect(resolveVisualizationSettings({ ...base, layers: [] })).toEqual({ providers: ["mermaid", "mindmesh"], outputDir: path.join(home, ".casper/visualizations/my-repo") });
  expect(resolveVisualizationSettings({ ...base, layers: [
    { document: { visualize: { outputDir: "~/diagrams", providers: ["mermaid"] } }, source: "global" },
    { document: { visualize: { providers: [" mindmesh "] } }, source: "profile" },
  ] })).toEqual({ providers: ["mindmesh"], outputDir: path.join(home, "diagrams") });
  expect(resolveVisualizationSettings({ ...base, layers: [
    { document: { visualize: { outputDir: "/abs/dir" } }, source: "profile" },
    { document: { visualize: { outputDir: false } }, source: "project" },
  ] }).outputDir).toBeNull();
  expect(() => resolveVisualizationSettings({ ...base, layers: [{ document: { visualize: { outputDir: "/etc" } }, source: "project" }] })).toThrow("may only be set in global or profile");
  expect(() => resolveVisualizationSettings({ ...base, layers: [{ document: { visualize: { outputDir: "" } }, source: "global" }] })).toThrow("path or false");
  expect(() => resolveVisualizationSettings({ ...base, layers: [{ document: { visualize: { providers: [] } }, source: "global" }] })).toThrow("nonempty list");
  expect(() => resolveVisualizationSettings({ ...base, layers: [{ document: { visualize: "yes" }, source: "global" }] })).toThrow("must be a mapping");
});

needsSymlinks("repo graph resolves relative imports, groups by directory, ignores vendored/symlinked trees, and collapses large graphs", async () => {
  const root = await tempDir("casper-viz-repo-");
  await mkdir(path.join(root, "src/util"), { recursive: true });
  await mkdir(path.join(root, "node_modules/dep"), { recursive: true });
  await mkdir(path.join(root, ".hidden"), { recursive: true });
  await writeFile(path.join(root, "src/index.ts"), 'import { a } from "./util/a";\nimport b from "./util/b.js";\nexport * from "./util";\nimport x from "external";\nconst y = require("./missing");\nimport type { T } from "./util/a";\n');
  await writeFile(path.join(root, "src/util/a.ts"), 'import "./b";\n');
  await writeFile(path.join(root, "src/util/b.ts"), 'export default 1;\n');
  await writeFile(path.join(root, "src/util/index.ts"), 'export { a } from "./a";\n');
  await writeFile(path.join(root, "src/types.d.ts"), 'import "./util/a";\n');
  await writeFile(path.join(root, "node_modules/dep/index.js"), 'require("../../src/index");\n');
  await writeFile(path.join(root, ".hidden/h.ts"), 'import "../src/index";\n');
  await symlink(path.join(root, "src"), path.join(root, "linked"));

  const repo = await buildRepoGraph({ root });
  expect(repo.granularity).toBe("file");
  expect(repo.filesScanned).toBe(4);
  expect(repo.graph.title).toBe(`${path.basename(root)} module dependencies`);
  expect(repo.graph.nodes).toEqual([
    { id: "src/index.ts", label: "src/index.ts", group: "src" },
    { id: "src/util/a.ts", label: "src/util/a.ts", group: "src/util" },
    { id: "src/util/b.ts", label: "src/util/b.ts", group: "src/util" },
    { id: "src/util/index.ts", label: "src/util/index.ts", group: "src/util" },
  ]);
  expect(repo.graph.edges).toEqual([
    { from: "src/index.ts", to: "src/util/a.ts" },
    { from: "src/index.ts", to: "src/util/b.ts" },
    { from: "src/index.ts", to: "src/util/index.ts" },
    { from: "src/util/a.ts", to: "src/util/b.ts" },
    { from: "src/util/index.ts", to: "src/util/a.ts" },
  ]);
  expect(repo.notes).toEqual([
    "1 package import(s) omitted (only relative imports are drawn).",
    "1 relative import(s) could not be resolved to a scanned file.",
  ]);

  const scoped = await buildRepoGraph({ root, scope: "src/util" });
  expect(scoped.graph.nodes.map((node) => node.id)).toEqual(["a.ts", "b.ts", "index.ts"]);
  expect(scoped.graph.nodes[0]).not.toHaveProperty("group");
  await expect(buildRepoGraph({ root, scope: "../" })).rejects.toThrow("inside the project");
  await expect(buildRepoGraph({ root, scope: "src/index.ts" })).rejects.toThrow("not a directory");
  // An explicitly requested scope is scanned even when it would be skipped as a descendant.
  const vendored = await buildRepoGraph({ root, scope: "node_modules" });
  expect(vendored.graph.nodes.map((node) => node.id)).toEqual(["dep/index.js"]);
  expect(vendored.notes).toEqual(["1 relative import(s) could not be resolved to a scanned file."]);
  await mkdir(path.join(root, "empty"));
  await expect(buildRepoGraph({ root, scope: "empty" })).rejects.toThrow("No JavaScript/TypeScript sources");

  const collapsed = await buildRepoGraph({ root, maxFileNodes: 2 });
  expect(collapsed.granularity).toBe("directory");
  expect(collapsed.graph.nodes).toEqual([{ id: "src", label: "src (1 files)" }, { id: "src/util", label: "src/util (3 files)" }]);
  expect(collapsed.graph.edges).toEqual([{ from: "src", to: "src/util", label: "3 imports" }]);
  expect(collapsed.notes.at(-1)).toBe("Collapsed 4 files into 2 directories (file graph exceeds 2 nodes).");

  const partial = await buildRepoGraph({ root, maxFiles: 2 });
  expect(partial.truncated).toBe(true);
  expect(partial.notes[0]).toBe("Scan stopped at 2 files; the graph is partial.");
});

test("visualize tool validates arguments, bounds results, and reports repo scans", async () => {
  const root = await tempDir("casper-viz-tool-");
  await writeFile(path.join(root, "a.ts"), 'import "./b";\n');
  await writeFile(path.join(root, "b.ts"), "export {};\n");
  const router = new VisualizationRouter({ workspaceRoot: root, providers: [new MermaidProvider()], settings: { providers: ["mermaid"], outputDir: null } });
  const [tool] = visualizationTools({ router, projectRoot: root });
  expect(tool!.name).toBe("visualize");

  const ok = JSON.parse((await tool!.execute({ graph: authFlow })).text);
  expect(ok.isError).toBe(false);
  expect(ok.truncated).toBe(false);
  expect(ok.data.primary.provider).toBe("mermaid");
  expect(ok.data.primary.content).toContain("flowchart TD");
  expect(ok.data.nodeCount).toBe(4);
  expect(ok.data.notes.at(-1)).toBe("Visualization is read-only; it does not authorize code changes.");

  const repo = JSON.parse((await tool!.execute({ source: "repo" })).text);
  expect(repo.isError).toBe(false);
  expect(repo.data.type).toBe("dependency-graph");
  expect(repo.data.notes[0]).toBe("Scanned 2 files at file granularity.");
  expect(repo.data.primary.content).toContain('n0["a.ts"] --> n1["b.ts"]'.replace('["a.ts"] --> n1["b.ts"]', " --> n1"));

  for (const [args, message] of [
    [{ graph: authFlow, bogus: 1 }, "Invalid visualize arguments"],
    [{ source: "svg", graph: authFlow }, "source must be graph or repo"],
    [{ source: "repo", graph: authFlow }, "repo source does not accept a graph"],
    [{ graph: authFlow, scope: "src" }, "scope applies only to repo source"],
    [{ source: "repo", scope: 3 }, "scope must be a string"],
    [{ source: "repo", scope: "../" }, "inside the project"],
    [{ graph: { ...authFlow, type: "pie" } }, "type must be one of"],
    [{}, "expected an object"],
  ] as const) {
    const result = await tool!.execute(args as Record<string, unknown>);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.text).data.error).toContain(message);
  }

  const huge = { type: "plan", title: "Huge", nodes: Array.from({ length: 350 }, (_, i) => ({ id: `n${i}`, label: `Step ${i} ${"x".repeat(60)}` })), edges: Array.from({ length: 349 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}` })) };
  const bounded = JSON.parse((await tool!.execute({ graph: huge })).text);
  expect(bounded.isError).toBe(false);
  expect(bounded.truncated).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(16_384);
  expect(bounded.summary).toContain("truncated");
});

test("task classification recognizes visualization requests as read-only without verification", () => {
  for (const request of ["map out the authentication flow", "show me the auth flow as a mind map", "visualize the MCP architecture before we change it", "draw a flowchart of the repair loop", "Diagram the dependency graph"]) {
    expect(classifyTask(request)).toEqual({ intent: "visualize", mode: "read", verification: [] });
  }
  expect(classifyTask("fix the broken diagram export").intent).toBe("fix");
  expect(classifyTask("add a map of features").intent).toBe("implement");
});

test("regression: oversized sources are skipped without crashing and are disclosed", async () => {
  const root = await tempDir("casper-viz-big-");
  await writeFile(path.join(root, "big.ts"), "export const x = 1;\n".padEnd(1_100_000, "/"));
  await writeFile(path.join(root, "a.ts"), 'import "./big";\n');
  const repo = await buildRepoGraph({ root });
  expect(repo.graph.nodes.map((node) => node.id)).toEqual(["a.ts", "big.ts"]);
  expect(repo.graph.edges).toEqual([{ from: "a.ts", to: "big.ts" }]);
  expect(repo.notes).toContain("1 file(s) over 1 MiB were not parsed for imports.");
});

test("regression: concurrent renders with identical titles and timestamps get distinct artifact names", async () => {
  const out = await tempDir("casper-viz-race-");
  const router = new VisualizationRouter({ workspaceRoot: await tempDir("casper-viz-workspace-"), providers: [new MermaidProvider()], settings: { providers: ["mermaid"], outputDir: out }, now: () => new Date(0) });
  const graph: VisualizationGraph = { type: "plan", title: "Same", nodes: [{ id: "a", label: "A" }], edges: [] };
  const results = await Promise.all([router.render(graph), router.render(graph), router.render(graph)]);
  const names = results.map((result) => path.basename(result.artifacts[0]!.path));
  expect(new Set(names).size).toBe(3);
  expect(names.sort()).toEqual(["1970-01-01T00-00-00-000Z-same-2.mermaid.mmd", "1970-01-01T00-00-00-000Z-same-3.mermaid.mmd", "1970-01-01T00-00-00-000Z-same.mermaid.mmd"]);
  expect(await readdir(out)).toHaveLength(3);
});

test("regression: Mermaid titles with colons and labels that strip to nothing stay syntactically valid", async () => {
  const result = await new MermaidProvider().render({ type: "mindmap", title: "Note: a #1", nodes: [{ id: "a", label: "(((" }, { id: "b", label: "B" }], edges: [{ from: "a", to: "b" }] });
  expect(result.content.split("\n").slice(0, 5)).toEqual(["---", 'title: "Note: a #1"', "---", "mindmap", "  root((unnamed))"]);
  const flow = await new MermaidProvider().render({ type: "plan", title: 'Plan: "x"', nodes: [{ id: "a", label: "A" }], edges: [] });
  expect(flow.content).toContain('title: "Plan: \\"x\\""');
});

test("performance: import matching is linear on adversarial sources", async () => {
  const root = await tempDir("casper-viz-evil-");
  await writeFile(path.join(root, "evil.ts"), ("import " + "x ".repeat(200) + "\n").repeat(2500));
  const started = performance.now();
  const repo = await buildRepoGraph({ root });
  expect(performance.now() - started).toBeLessThan(500);
  expect(repo.filesScanned).toBe(1);
});
