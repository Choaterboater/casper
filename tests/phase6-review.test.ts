import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyTask } from "../src/task/classify";
import { MermaidProvider } from "../src/visualize/mermaid";
import { MindMeshProvider } from "../src/visualize/mindmesh";
import { buildRepoGraph } from "../src/visualize/repo";
import { VisualizationRouter, resolveVisualizationSettings } from "../src/visualize/router";
import { parseVisualizationGraph, spanningTree } from "../src/visualize/types";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "casper-review-")); roots.push(root);
  const workspace = path.join(root, "workspace"); await fs.mkdir(workspace);
  return { root, workspace, out: path.join(root, "out") };
}
const graph = parseVisualizationGraph({ type: "mindmap", title: "Forest", nodes: ["__root__", "__root__1", "casper-forest: root"].map(id => ({ id, label: id })), edges: [] });

test("review: synthetic identity and rendered identities cannot shadow graph nodes", async () => {
  const tree = spanningTree(graph);
  expect(graph.nodes.map(n => n.id)).not.toContain(tree.rootId);
  const promoted = spanningTree(parseVisualizationGraph({ ...graph,
    nodes: ["__root__", "island"].map(id => ({ id, label: id })),
    edges: [{ from: "island", to: "island" }] }));
  expect(promoted.rootId).not.toBe("__root__");
  for (const provider of [new MermaidProvider(), new MindMeshProvider()]) {
    const result = await provider.render(graph);
    if (provider.name === "mindmesh") {
      const map = JSON.parse(result.content);
      expect(Object.keys(map.nodes)).toHaveLength(4);
      expect(map.nodes[map.rootId].childIds).toHaveLength(3);
      for (const id of map.nodes[map.rootId].childIds) expect(map.nodes[id].parentId).toBe(map.rootId);
    } else for (const node of graph.nodes) expect(result.content).toContain(node.label);
  }
});
test("review: visualization action takes precedence over subject keywords", () => {
  for (const request of ["map out the refactor scope", "diagram the test flow", "can you diagram the test flow", "visualize the fix", "draw the verification flow", "show me a diagram of the test flow", "show me the refactor scope as a dependency graph"]) {
    expect(classifyTask(request)).toEqual({ intent: "visualize", mode: "read", verification: [] });
  }
});
test("review follow-up: visualization words used as nouns do not suppress authorized verification", () => {
  for (const request of ["fix the chart export crash", "refactor the draw function", "fix the diagram parser", "add tests for chart rendering", "fix the crash when exporting as a diagram"]) {
    expect(classifyTask(request).mode).toBe("modify");
    expect(classifyTask(request).verification.length).toBeGreaterThan(0);
  }
});
test("review: global relative artifact path resolves under user home", async () => {
  const { root } = await fixture();
  expect(resolveVisualizationSettings({ homeDir: root, projectName: "x", layers: [{ source: "global", document: { visualize: { outputDir: "diagrams" } } }] }).outputDir).toBe(path.join(root, "diagrams"));
});
test("review: canonical workspace destinations rejected before creating directories", async () => {
  const { root, workspace } = await fixture();
  const alias = path.join(root, "alias"); await fs.symlink(workspace, alias);
  for (const outputDir of [workspace, path.join(workspace, "new/deep"), path.join(alias, "new/deep")]) {
    const router = new VisualizationRouter({ workspaceRoot: alias, providers: [new MermaidProvider()], settings: { providers: ["mermaid"], outputDir } });
    await expect(router.render({ ...graph, type: "flowchart" })).rejects.toThrow(/outside.*workspace/);
    expect(await fs.readdir(workspace)).toEqual([]);
  }
});
test("review: cancellation in final provider prevents persistence, including inline results", async () => {
  const { workspace, out } = await fixture();
  for (const outputDir of [out, null]) {
    const controller = new AbortController();
    const provider = new MermaidProvider();
    const render = provider.render.bind(provider);
    provider.render = async g => { const result = await render(g); controller.abort(); return result; };
    const router = new VisualizationRouter({ workspaceRoot: workspace, providers: [provider], settings: { providers: ["mermaid"], outputDir } });
    await expect(router.render({ ...graph, type: "flowchart" }, controller.signal)).rejects.toThrow("Visualization cancelled");
  }
  expect(await fs.readdir(workspace)).toEqual([]);
  expect(await fs.stat(out).catch(() => null)).toBeNull();
});
test("review: cancellation during directory setup prevents files", async () => {
  const { workspace, out } = await fixture();
  const controller = new AbortController();
  const original = fs.open;
  const mock = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const value = await original(...args); controller.abort(); return value;
  });
  try {
    const router = new VisualizationRouter({ workspaceRoot: workspace, providers: [new MermaidProvider()], settings: { providers: ["mermaid"], outputDir: out } });
    await expect(router.render({ ...graph, type: "flowchart" }, controller.signal)).rejects.toThrow("Visualization cancelled");
    expect(await fs.readdir(out).catch(() => [])).toEqual([]);
  } finally { mock.mockRestore(); }
});
test("review: repository scope cannot follow symlinks outside the project", async () => {
  const { root, workspace } = await fixture();
  const external = path.join(root, "external");
  await fs.mkdir(external);
  await fs.writeFile(path.join(external, "private.ts"), "export const secret = 1;");
  await fs.symlink(external, path.join(workspace, "linked"));
  await expect(buildRepoGraph({ root: workspace, scope: "linked" })).rejects.toThrow("inside the project");
  const internal = path.join(workspace, "..sources");
  await fs.mkdir(internal);
  await fs.writeFile(path.join(internal, "public.ts"), "export {};");
  await fs.symlink(workspace, path.join(root, "workspace-alias"));
  expect((await buildRepoGraph({ root: path.join(root, "workspace-alias"), scope: "..sources" })).filesScanned).toBe(1);
});

test("review: long multibyte repository paths yield deterministic validated IR", async () => {
  const { workspace } = await fixture();
  const scope = path.join("界".repeat(45), "界".repeat(45));
  const dir = path.join(workspace, scope); await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "a.ts"), 'import "./b";');
  await fs.writeFile(path.join(dir, "b.ts"), "export {};");
  for (const options of [{}, { maxFileNodes: 1 }, { scope }]) {
    const result = await buildRepoGraph({ root: workspace, ...options });
    expect(() => parseVisualizationGraph(result.graph)).not.toThrow();
    expect(result.truncated).toBe(true);
    expect(result.notes.join(" ")).toMatch(/shorten|truncat/i);
    expect((await buildRepoGraph({ root: workspace, ...options })).graph).toEqual(result.graph);
    if (!Object.keys(options).length) expect(result.graph.edges).toEqual([{ from: result.graph.nodes[0]!.id, to: result.graph.nodes[1]!.id }]);
  }
});

test("review follow-up: replacing the artifact directory with a workspace symlink cannot redirect writes", async () => {
  const { root, workspace, out } = await fixture(); await fs.mkdir(out);
  const retained = path.join(root, "original-output");
  const actualOut = await fs.realpath(out);
  let held = false; let resolutions = 0;
  const open = fs.open; const resolve = fs.realpath;
  const opened = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args); if (String(args[0]).includes("/fd/") && args[1] === constants.O_RDONLY) held = true; return file;
  });
  const resolved = spyOn(fs, "realpath").mockImplementation((async (...args: Parameters<typeof fs.realpath>) => {
    const value = await resolve(...args);
    if (held && args[0] === actualOut && ++resolutions === 2) {
      await fs.rename(out, retained); await fs.symlink(workspace, out);
    }
    return value;
  }) as typeof fs.realpath);
  try {
    const router = new VisualizationRouter({ workspaceRoot: workspace, providers: [new MermaidProvider()], settings: { providers: ["mermaid"], outputDir: out } });
    await expect(router.render(graph)).rejects.toThrow("directory changed");
    expect(await fs.readdir(workspace)).toEqual([]);
    expect(await fs.readdir(retained)).toEqual([]);
  } finally { opened.mockRestore(); resolved.mockRestore(); }
});

test("review final: a swapped ancestor cannot redirect creation of missing output directories", async () => {
  const { root, workspace, out } = await fixture(); await fs.mkdir(out);
  const actualOut = await fs.realpath(out); const retained = path.join(root, "retained");
  const resolve = fs.realpath; let swapped = false;
  const mock = spyOn(fs, "realpath").mockImplementation((async (...args: Parameters<typeof fs.realpath>) => {
    const result = await resolve(...args);
    if (!swapped && (args[0] === out || args[0] === actualOut)) {
      swapped = true; await fs.rename(out, retained); await fs.symlink(workspace, out);
    }
    return result;
  }) as typeof fs.realpath);
  try {
    const router = new VisualizationRouter({ workspaceRoot: workspace, providers: [new MermaidProvider()], settings: { providers: ["mermaid"], outputDir: path.join(out, "new/nested") } });
    await expect(router.render(graph)).rejects.toThrow();
    expect(swapped).toBe(true);
    expect(await fs.readdir(workspace)).toEqual([]);
  } finally { mock.mockRestore(); }
});

test("review: cancellation after open or write cleans only this render's artifacts", async () => {
  for (const boundary of ["open", "write"] as const) {
    const { workspace, out } = await fixture();
    await fs.mkdir(out);
    await fs.writeFile(path.join(out, "keep.txt"), "keep");
    const controller = new AbortController();
    const original = fs.open;
    let opens = 0;
    const mock = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const file = await original(...args);
      if (String(args[0]).includes("/fd/") && args[1] === constants.O_WRONLY && ++opens === 2) {
        if (boundary === "open") controller.abort();
        else {
          const write = file.writeFile.bind(file);
          file.writeFile = async (...writeArgs: Parameters<typeof file.writeFile>) => {
            await write(...writeArgs); controller.abort();
          };
        }
      }
      return file;
    });
    try {
      const router = new VisualizationRouter({ workspaceRoot: workspace, providers: [new MermaidProvider(), new MindMeshProvider()], settings: { providers: ["mermaid", "mindmesh"], outputDir: out } });
      await expect(router.render(graph, controller.signal)).rejects.toThrow("Visualization cancelled");
      expect(opens).toBe(2);
      expect(await fs.readdir(out)).toEqual(["keep.txt"]);
      expect(await fs.readFile(path.join(out, "keep.txt"), "utf8")).toBe("keep");
    } finally { mock.mockRestore(); }
  }
});
