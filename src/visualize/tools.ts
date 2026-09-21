import type { RuntimeTool } from "../runtime/types";
import { boundCapabilityResult } from "../capabilities/result";
import { isRecord } from "../mcp/config";
import { buildRepoGraph } from "./repo";
import type { RenderedVisualization, VisualizationRouter } from "./router";
import { parseVisualizationGraph, VISUALIZATION_TYPES } from "./types";

export interface VisualizationToolOptions {
  router: VisualizationRouter;
  projectRoot: string;
}

/** Tool-facing envelope: primary content inline, secondary artifacts by path only. */
export function describeVisualization(rendered: RenderedVisualization, notes: string[] = []): Record<string, unknown> {
  return {
    type: rendered.graph.type,
    title: rendered.graph.title,
    nodeCount: rendered.graph.nodes.length,
    edgeCount: rendered.graph.edges.length,
    primary: { provider: rendered.primary.provider, format: rendered.primary.format, content: rendered.primary.content, lossiness: rendered.primary.lossiness },
    artifacts: rendered.artifacts.map((artifact) => ({ provider: artifact.provider, path: artifact.path, bytes: artifact.bytes, lossiness: artifact.lossiness })),
    skippedProviders: rendered.skipped,
    notes: [
      ...notes,
      ...(rendered.artifacts.length ? [] : [rendered.artifactNote ?? "No artifact written (visualize.outputDir disabled); content is in-conversation only."]),
      "Visualization is read-only; it does not authorize code changes.",
    ],
  };
}

export function visualizationTools(options: VisualizationToolOptions): RuntimeTool[] {
  const { router, projectRoot } = options;
  return [{
    name: "visualize",
    description: `Render a diagram from a neutral graph you author (type, title, nodes, edges) or, with source "repo", a deterministic relative-import dependency graph of the project. Providers: ${router.providerNames().join(", ")}. Primary provider output (Mermaid text) is returned inline; other formats are saved as files outside the workspace when enabled. Read-only: producing a diagram never authorizes edits. Output capped at 16 KiB/50 items with truncation disclosed.`,
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        source: { type: "string", enum: ["graph", "repo"], description: "graph (default): render the supplied graph. repo: scan project sources." },
        scope: { type: "string", description: "repo only: project-relative directory to scan." },
        graph: {
          type: "object", additionalProperties: false, required: ["type", "title", "nodes"],
          properties: {
            type: { type: "string", enum: [...VISUALIZATION_TYPES] },
            title: { type: "string" },
            nodes: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "label"], properties: {
              id: { type: "string" }, label: { type: "string" }, group: { type: "string" }, note: { type: "string" },
            } } },
            edges: { type: "array", items: { type: "object", additionalProperties: false, required: ["from", "to"], properties: {
              from: { type: "string" }, to: { type: "string" }, label: { type: "string" },
            } } },
          },
        },
      },
    },
    async execute(args, signal) {
      try {
        if (!isRecord(args) || Object.keys(args).some((key) => !["source", "scope", "graph"].includes(key))) throw new Error("Invalid visualize arguments");
        const source = args.source ?? "graph";
        if (source === "repo") {
          if (args.graph !== undefined) throw new Error("repo source does not accept a graph");
          if (args.scope !== undefined && typeof args.scope !== "string") throw new Error("scope must be a string");
          const repo = await buildRepoGraph({ root: projectRoot, scope: args.scope as string | undefined, signal });
          const rendered = await router.render(repo.graph, signal);
          return { text: JSON.stringify(boundCapabilityResult(describeVisualization(rendered, [`Scanned ${repo.filesScanned} files at ${repo.granularity} granularity.`, ...repo.notes]))) };
        }
        if (source !== "graph") throw new Error("source must be graph or repo");
        if (args.scope !== undefined) throw new Error("scope applies only to repo source");
        const graph = parseVisualizationGraph(args.graph);
        const rendered = await router.render(graph, signal);
        return { text: JSON.stringify(boundCapabilityResult(describeVisualization(rendered))) };
      } catch (error) {
        return { text: JSON.stringify(boundCapabilityResult({ isError: true, error: error instanceof Error ? error.message : "Visualization failed" })), isError: true };
      }
    },
  }];
}
