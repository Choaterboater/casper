# Phase 6 — Visualization Implementation

Status: implemented and locally validated; independent Standards/Spec review and corrective follow-up are recorded in `docs/PHASE6_REVIEW.md`. The broader-plan interactive MindMesh connection remains an explicit scope gap; the adapter is file-based. Nothing committed or pushed.

## Contract (from `docs/CASPER_COMPLETE_PLAN.md` §17A and Phase 6)

Build a generic graph IR, a `VisualizationProvider` interface, a Mermaid fallback, and a MindMesh adapter. Acceptance: `> map out the authentication flow` produces a useful visual without affecting the code workspace.

## Delivered

| Plan item | Implementation |
| --- | --- |
| Generic graph IR | `src/visualize/types.ts` — `VisualizationGraph` (type/title/nodes/edges), `parseVisualizationGraph` validation with byte and count limits, deterministic `spanningTree` projection for tree formats. |
| `VisualizationProvider` | `supports(type)` / `render(graph)` returning content, format, MIME type, and an explicit `lossiness` list. |
| Mermaid fallback | `src/visualize/mermaid.ts` — flowchart (subgraphs for groups, labeled edges, entity-code escaping) and mindmap (tree projection, cross edges as comments). Always available. |
| MindMesh adapter | `src/visualize/mindmesh.ts` — emits MindMesh canonical schema-6 documents. Cross edges, groups, edge labels, and original ids preserved in `extensions.casper` and node notes. File output only; no server connection. |
| Routing | `src/visualize/router.ts` — ordered providers, primary inline result, artifacts written with exclusive create outside the workspace, settings resolution with layer-aware `outputDir` restriction. |
| Repo graph | `src/visualize/repo.ts` — deterministic relative-import dependency graph with directory collapse and honest unresolved/omitted counts (beyond the plan's minimum). |
| Tool and commands | `src/visualize/tools.ts` — `visualize` runtime tool; `src/app.ts` — `/visualize`, `/visualize repo [dir]`, startup line, tool exposure only for `visualize`-intent prompts. |
| Classification | `src/task/classify.ts` — new `visualize` intent, read mode, no verification. |
| Configuration | `src/config/load.ts`, `src/project/context.ts` — `visualize.providers` / `visualize.outputDir`. |

## Design decisions

- **Graph → tree is explicit and disclosed.** MindMesh maps and Mermaid mindmaps are trees. Rather than silently dropping edges, `spanningTree` picks a deterministic root, uses a synthetic root when needed, and reports cross edges in both output and `lossiness`.
- **No coupling to MindMesh source.** MindMesh's schema is structurally mirrored (`schemaVersion: 6`, `rootId`, `nodes{id,parentId,childIds,text,note?,extensions?}`, `layout`, `nodeAppearance`, `colorScheme`, `meta`). Casper's tests verify tree invariants with a local mirror of MindMesh's `validateMap` rules, so the suite never imports MindMesh code or depends on its checkout path.
- **Ids are namespaced.** Graph ids are user-controlled and become `<mapId>:<id>`. The generic tree allocator chooses a synthetic identity absent from input IDs; MindMesh separately allocates a collision-free rendered root ID. The previous reserved-shape argument did not protect generic projection and was corrected in review.
- **Writes stay outside the workspace.** Default `~/.casper/visualizations/<project-slug>/`. Project configuration can disable but cannot redirect the directory. Files use `wx` so nothing is overwritten.
- **Tool exposure is intent-scoped.** The `visualize` tool is added only when the prompt classifies as `visualize`, keeping existing tool-count invariants in Phase 4/5 tests intact and avoiding a permanent tool-schema tax.
- **Bounded results.** Tool output flows through the shared `boundCapabilityResult` (16 KiB / 50 items) with truncation disclosed; secondary artifacts are referenced by path and byte count only.

## Validation

- `bun run check`: TypeScript passed, **132 tests / 781 assertions** (previously 117 / 596). Fifteen new tests in `tests/phase6-visualize.test.ts` (11) and `tests/phase6-app.integration.test.ts` (4).
- Acceptance test (`phase6-app.integration.test.ts`): a fake runtime receives the `visualize` tool only for `map out the authentication flow`, submits a model-authored graph, gets Mermaid inline plus Mermaid and MindMesh artifacts under the test home, and the project tree is byte-identical before and after. A follow-up ordinary prompt carries no visualization tool.
- Real CLI run against Casper itself with a temporary `HOME`: `/visualize repo src` scanned 34 files, rendered an 11-subgraph Mermaid flowchart, wrote both artifacts (2711 B `.mmd`, 40011 B `.json`), and started no model session.
- One-off external acceptance (not part of the suite): the emitted MindMesh JSON was read by MindMesh's actual `jsonImporter` (`~/Documents/mindmesh/packages/exchange/src/json.ts`) with **0 migration notes and 0 invariant issues**; `validateMap` on the raw document also returned no issues, including a fully cyclic mindmap fixture.

## Defects found and fixed during implementation

- Synthetic root id collision: a graph node with id `root` namespaced to `<mapId>:root`, identical to the original synthetic root id. Fixed with the reserved `: root` shape and a regression test.
- Test fixture assumption: the sample authentication flow is fully cyclic, so the deterministic root is the highest fan-out node (`api`), not the first-listed node. Tests now cover both the cyclic and acyclic variants explicitly.

## Not included

- Graphviz provider, image rendering, or a live/interactive MindMesh connection (the plan's "interactive MindMesh" branch is deferred until a consent model like `/mcp connect` exists for it).
- Non-JS/TS languages, path aliases, or dynamic specifiers in the repository graph.
- `casper.registerVisualizationProvider(...)` extension API; providers are injectable through `CasperAppOptions.visualizationProviders` only.

## Remaining gates

1. See `docs/PHASE6_REVIEW.md` for independent review findings/follow-up; interactive MindMesh remains unimplemented and is not counted as accepted.
2. Optional live-model smoke where a real model authors a graph through the `visualize` tool.
3. Commit only if requested.
