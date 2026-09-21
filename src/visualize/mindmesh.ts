import { spanningTree, type SpanningTree, type VisualizationGraph, type VisualizationProvider, type VisualizationResult, type VisualizationType } from "./types";

/**
 * MindMesh canonical document, schema version 6 (`@mindmesh/map-model`). Structurally
 * mirrored here so Casper never depends on MindMesh code or its repository layout; the
 * output is what MindMesh's own lossless `json` importer accepts.
 */
export const MINDMESH_SCHEMA_VERSION = 6;

interface MindMeshNode {
  id: string;
  parentId: string | null;
  childIds: string[];
  text: string;
  note?: string;
  extensions?: Record<string, unknown>;
}

interface MindMeshMap {
  schemaVersion: number;
  id: string;
  title: string;
  rootId: string;
  nodes: Record<string, MindMeshNode>;
  layout: "balanced" | "rightward";
  nodeAppearance: "hierarchical" | "boxed";
  colorScheme: "classic" | "teal";
  meta: { createdAt: string; updatedAt: string };
}

export interface MindMeshProviderOptions {
  /** Deterministic clock for tests. */
  now?: () => string;
  /** Deterministic map id for tests; default derives from the title. */
  mapId?: (graph: VisualizationGraph) => string;
}

/** Writes MindMesh JSON files; it does not connect to or start a MindMesh server. */
export class MindMeshProvider implements VisualizationProvider {
  readonly name = "mindmesh";
  private readonly now: () => string;
  private readonly mapId: (graph: VisualizationGraph) => string;

  constructor(options: MindMeshProviderOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.mapId = options.mapId ?? ((graph) => `casper-${slug(graph.title)}`);
  }

  supports(_type: VisualizationType): boolean { return true; }

  async render(graph: VisualizationGraph): Promise<VisualizationResult> {
    const { map, tree } = projectMindMeshMap(graph, this.mapId(graph), this.now());
    const lossiness: string[] = [];
    if (tree.syntheticRoot) lossiness.push("No single root node; the title is used as a synthetic root.");
    if (tree.crossEdges.length) lossiness.push(`${tree.crossEdges.length} cross edge(s) are recorded in node notes/extensions, not drawn as branches.`);
    if (graph.nodes.some((node) => node.group)) lossiness.push("Groups are recorded in node extensions, not drawn.");
    if (graph.edges.some((edge) => edge.label)) lossiness.push("Edge labels are recorded in node extensions only.");
    return { provider: this.name, format: "json", mimeType: "application/json", content: JSON.stringify(map, null, 2) + "\n", lossiness };
  }
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "map";
}

export function toMindMeshMap(graph: VisualizationGraph, mapId: string, now: string): MindMeshMap {
  return projectMindMeshMap(graph, mapId, now).map;
}

/** Builds the document and returns the tree projection used, so callers need not recompute it. */
export function projectMindMeshMap(graph: VisualizationGraph, mapId: string, now: string): { map: MindMeshMap; tree: SpanningTree } {
  const tree = spanningTree(graph);
  // Allocate output identity independently of the internal projection identity.
  const outputIds = new Set(graph.nodes.map((node) => `${mapId}:${node.id}`));
  let rootId = `${mapId}: root`;
  for (let suffix = 1; outputIds.has(rootId); suffix++) rootId = `${mapId}: root${suffix}`;
  const crossEdgeSet = new Set(tree.crossEdges);
  const nodeId = (id: string) => (tree.syntheticRoot && id === tree.rootId ? rootId : `${mapId}:${id}`);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const nodes: Record<string, MindMeshNode> = {};

  const incomingCross = new Map<string, typeof tree.crossEdges>();
  const outgoingCross = new Map<string, typeof tree.crossEdges>();
  for (const edge of tree.crossEdges) {
    (outgoingCross.get(edge.from) ?? outgoingCross.set(edge.from, []).get(edge.from)!).push(edge);
    (incomingCross.get(edge.to) ?? incomingCross.set(edge.to, []).get(edge.to)!).push(edge);
  }
  const treeEdgeLabels = new Map<string, string>();
  for (const edge of graph.edges) {
    if (!crossEdgeSet.has(edge) && edge.label && !treeEdgeLabels.has(edge.to)) treeEdgeLabels.set(edge.to, edge.label);
  }

  const visit = (id: string, parentId: string | null) => {
    const synthetic = tree.syntheticRoot && id === tree.rootId;
    const source = synthetic ? undefined : byId.get(id)!;
    const children = tree.children.get(id) ?? [];
    const extensions: Record<string, unknown> = {};
    const noteLines: string[] = [];
    if (synthetic) {
      extensions.casper = { graphType: graph.type, syntheticRoot: true, crossEdges: tree.crossEdges };
    } else {
      const casper: Record<string, unknown> = { graphId: source!.id };
      if (id === tree.rootId) casper.graphType = graph.type;
      if (source!.group) casper.group = source!.group;
      const parentLabel = treeEdgeLabels.get(id);
      if (parentLabel) casper.edgeLabel = parentLabel;
      const out = outgoingCross.get(id) ?? [];
      const inc = incomingCross.get(id) ?? [];
      if (out.length) {
        casper.crossEdgesOut = out.map((edge) => ({ to: edge.to, label: edge.label }));
        for (const edge of out) noteLines.push(`→ ${byId.get(edge.to)!.label}${edge.label ? ` (${edge.label})` : ""}`);
      }
      if (inc.length) {
        casper.crossEdgesIn = inc.map((edge) => ({ from: edge.from, label: edge.label }));
        for (const edge of inc) noteLines.push(`← ${byId.get(edge.from)!.label}${edge.label ? ` (${edge.label})` : ""}`);
      }
      if (source!.note) noteLines.unshift(source!.note);
      extensions.casper = casper;
    }
    const node: MindMeshNode = { id: nodeId(id), parentId, childIds: children.map(nodeId), text: synthetic ? graph.title : source!.label };
    if (noteLines.length) node.note = noteLines.join("\n");
    node.extensions = extensions;
    nodes[node.id] = node;
    for (const child of children) visit(child, node.id);
  };
  visit(tree.rootId, null);

  const map: MindMeshMap = {
    schemaVersion: MINDMESH_SCHEMA_VERSION,
    id: mapId,
    title: graph.title,
    rootId: nodeId(tree.rootId),
    nodes,
    layout: graph.type === "mindmap" ? "balanced" : "rightward",
    nodeAppearance: graph.type === "mindmap" ? "hierarchical" : "boxed",
    colorScheme: "teal",
    meta: { createdAt: now, updatedAt: now },
  };
  return { map, tree };
}
