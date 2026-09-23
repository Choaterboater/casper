import { isRecord } from "../mcp/config";

export const VISUALIZATION_TYPES = [
  "mindmap",
  "architecture",
  "dependency-graph",
  "flowchart",
  "troubleshooting-tree",
  "plan",
] as const;

export type VisualizationType = (typeof VISUALIZATION_TYPES)[number];

export interface GraphNode {
  id: string;
  label: string;
  /** Optional grouping (module, layer, subsystem). Rendered as a subgraph where supported. */
  group?: string;
  /** Optional free text shown as a note where the provider supports it. */
  note?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  label?: string;
}

/** Neutral graph intermediate representation. Provider file formats never leak into reasoning output. */
export interface VisualizationGraph {
  type: VisualizationType;
  title: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface VisualizationResult {
  provider: string;
  /** File extension without dot, e.g. "mmd" or "json". */
  format: string;
  mimeType: string;
  content: string;
  /** Honest disclosure of information the provider's format cannot represent. */
  lossiness: string[];
}

export interface VisualizationProvider {
  readonly name: string;
  supports(type: VisualizationType): boolean;
  render(graph: VisualizationGraph): Promise<VisualizationResult>;
}

export const GRAPH_LIMITS = { maxNodes: 400, maxEdges: 800, maxLabelBytes: 200, maxNoteBytes: 1000, maxTitleBytes: 200 } as const;

function bounded(value: unknown, field: string, maxBytes: number, allowEmpty = false): string {
  if (typeof value !== "string") throw new Error(`Invalid graph: ${field} must be a string`);
  const text = value.trim();
  if (!text && !allowEmpty) throw new Error(`Invalid graph: ${field} must not be empty`);
  if (Buffer.byteLength(text) > maxBytes) throw new Error(`Invalid graph: ${field} exceeds ${maxBytes} bytes`);
  return text;
}

/** Validate untrusted (model-authored or file-loaded) graph input into a normalized IR. */
export function parseVisualizationGraph(value: unknown): VisualizationGraph {
  if (!isRecord(value)) throw new Error("Invalid graph: expected an object");
  const allowed = ["type", "title", "nodes", "edges"];
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`Invalid graph: unknown fields ${unknown.join(", ")}`);
  if (!VISUALIZATION_TYPES.includes(value.type as VisualizationType)) {
    throw new Error(`Invalid graph: type must be one of ${VISUALIZATION_TYPES.join(", ")}`);
  }
  const title = bounded(value.title, "title", GRAPH_LIMITS.maxTitleBytes);
  if (!Array.isArray(value.nodes) || !value.nodes.length) throw new Error("Invalid graph: nodes must be a nonempty array");
  if (value.nodes.length > GRAPH_LIMITS.maxNodes) throw new Error(`Invalid graph: more than ${GRAPH_LIMITS.maxNodes} nodes`);
  const edgesInput = value.edges ?? [];
  if (!Array.isArray(edgesInput)) throw new Error("Invalid graph: edges must be an array");
  if (edgesInput.length > GRAPH_LIMITS.maxEdges) throw new Error(`Invalid graph: more than ${GRAPH_LIMITS.maxEdges} edges`);

  const ids = new Set<string>();
  const nodes: GraphNode[] = value.nodes.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`Invalid graph: node ${index} must be an object`);
    const extra = Object.keys(entry).filter((key) => !["id", "label", "group", "note"].includes(key));
    if (extra.length) throw new Error(`Invalid graph: node ${index} has unknown fields ${extra.join(", ")}`);
    const id = bounded(entry.id, `node ${index} id`, GRAPH_LIMITS.maxLabelBytes);
    if (ids.has(id)) throw new Error(`Invalid graph: duplicate node id ${JSON.stringify(id)}`);
    ids.add(id);
    const node: GraphNode = { id, label: bounded(entry.label, `node ${id} label`, GRAPH_LIMITS.maxLabelBytes) };
    if (entry.group !== undefined) node.group = bounded(entry.group, `node ${id} group`, GRAPH_LIMITS.maxLabelBytes);
    if (entry.note !== undefined) node.note = bounded(entry.note, `node ${id} note`, GRAPH_LIMITS.maxNoteBytes, true);
    return node;
  });

  const edges: GraphEdge[] = edgesInput.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`Invalid graph: edge ${index} must be an object`);
    const extra = Object.keys(entry).filter((key) => !["from", "to", "label"].includes(key));
    if (extra.length) throw new Error(`Invalid graph: edge ${index} has unknown fields ${extra.join(", ")}`);
    const from = bounded(entry.from, `edge ${index} from`, GRAPH_LIMITS.maxLabelBytes);
    const to = bounded(entry.to, `edge ${index} to`, GRAPH_LIMITS.maxLabelBytes);
    for (const id of [from, to]) if (!ids.has(id)) throw new Error(`Invalid graph: edge ${index} references unknown node ${JSON.stringify(id)}`);
    const edge: GraphEdge = { from, to };
    if (entry.label !== undefined) edge.label = bounded(entry.label, `edge ${index} label`, GRAPH_LIMITS.maxLabelBytes);
    return edge;
  });

  return { type: value.type as VisualizationType, title, nodes, edges };
}

export interface SpanningTree {
  rootId: string;
  /** Present when no single natural root exists; the synthetic root is not a graph node. */
  syntheticRoot: boolean;
  children: Map<string, string[]>;
  /** Edges not used by the tree, in input order. Tree formats cannot draw these. */
  crossEdges: GraphEdge[];
}

/**
 * Deterministic tree projection of a general graph for tree-only formats.
 * Root: the zero-in-degree node; a fully cyclic graph roots at the highest fan-out node
 * (first in input order on ties). Multiple zero-in-degree candidates or unreachable
 * nodes are attached under a synthetic root.
 */
export function spanningTree(graph: VisualizationGraph, syntheticRootId = "__root__"): SpanningTree {
  const ids = new Set(graph.nodes.map((node) => node.id));
  const preferredRootId = syntheticRootId;
  for (let suffix = 1; ids.has(syntheticRootId); suffix++) syntheticRootId = `${preferredRootId}${suffix}`;
  const inDegree = new Map(graph.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map<string, GraphEdge[]>(graph.nodes.map((node) => [node.id, []]));
  for (const edge of graph.edges) {
    if (edge.from === edge.to) continue;
    inDegree.set(edge.to, inDegree.get(edge.to)! + 1);
    outgoing.get(edge.from)!.push(edge);
  }
  const sources = graph.nodes.filter((node) => inDegree.get(node.id) === 0);
  let candidates = sources;
  if (!candidates.length) {
    // Every node has an incoming edge (cyclic); pick the highest fan-out node.
    const best = [...graph.nodes].sort((a, b) => outgoing.get(b.id)!.length - outgoing.get(a.id)!.length)[0]!;
    candidates = [best];
  }

  const children = new Map<string, string[]>();
  const used = new Set<GraphEdge>();
  const visited = new Set<string>();
  const attach = (parent: string, child: string) => {
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent)!.push(child);
  };
  const bfs = (start: string) => {
    visited.add(start);
    const queue = [start];
    for (let head = 0; head < queue.length; head++) {
      const current = queue[head]!;
      for (const edge of outgoing.get(current)!) {
        if (visited.has(edge.to)) continue;
        visited.add(edge.to);
        used.add(edge);
        attach(current, edge.to);
        queue.push(edge.to);
      }
    }
  };

  let rootId: string;
  let syntheticRoot = false;
  if (candidates.length === 1) {
    rootId = candidates[0]!.id;
    bfs(rootId);
  } else {
    rootId = syntheticRootId;
    syntheticRoot = true;
    for (const candidate of candidates) { attach(rootId, candidate.id); bfs(candidate.id); }
  }
  for (const node of graph.nodes) {
    if (visited.has(node.id)) continue;
    if (!syntheticRoot) {
      // Promote to a synthetic root so unreachable nodes are still drawn.
      const natural = rootId;
      rootId = syntheticRootId;
      syntheticRoot = true;
      attach(rootId, natural);
    }
    attach(rootId, node.id);
    bfs(node.id);
  }
  const crossEdges = graph.edges.filter((edge) => !used.has(edge));
  return { rootId, syntheticRoot, children, crossEdges };
}
