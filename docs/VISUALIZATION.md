# Visualization

Visualization is a capability category, not a special Casper mode. Casper reasons about a system in a small neutral **graph IR**, then renders it through configured **providers**. Provider file formats never shape reasoning output, and rendering is read-only: a diagram never authorizes code changes.

## Graph IR

```json
{
  "type": "flowchart",
  "title": "Authentication flow",
  "nodes": [
    { "id": "ui", "label": "Login UI", "group": "web" },
    { "id": "api", "label": "Auth API", "group": "server", "note": "optional free text" }
  ],
  "edges": [{ "from": "ui", "to": "api", "label": "POST /login" }]
}
```

- `type`: `mindmap`, `architecture`, `dependency-graph`, `flowchart`, `troubleshooting-tree`, or `plan`.
- Nodes need unique `id` and `label`; `group` and `note` are optional. Edges reference existing node ids.
- Limits: 400 nodes, 800 edges, 200-byte ids/labels/groups, 1000-byte notes, 200-byte titles. Unknown fields are rejected. Input is validated in `parseVisualizationGraph` before any provider sees it.

## Providers

| Provider | Output | Notes |
| --- | --- | --- |
| `mermaid` (default primary) | `.mmd` text | Always available; no external process. Flowchart syntax for every type except `mindmap`, which uses Mermaid mindmap syntax. |
| `mindmesh` | `.json` document | MindMesh canonical map, schema version 6. Accepted unchanged by MindMesh's lossless `json` importer. **File output only** — Casper does not start, connect to, or authenticate with a MindMesh server. |

Providers implement `VisualizationProvider` (`supports(type)`, `render(graph)`); `CasperAppOptions.visualizationProviders` replaces the built-in set for tests or extensions.

### Tree projection and lossiness

Mindmaps and MindMesh documents are trees; the IR is a graph. `spanningTree` projects deterministically:

1. Root = the zero-in-degree node with the most outgoing edges (input order breaks ties).
2. Multiple candidates, unreachable islands, or fully cyclic graphs attach under a **synthetic root** titled with the graph title.
3. Edges not used by the tree are **cross edges**. Mermaid mindmaps list them as `%%` comments; MindMesh records them in node notes (`→`/`←` lines) and `extensions.casper` (`crossEdgesOut`/`crossEdgesIn`), along with `graphId`, `group`, `edgeLabel`, and `graphType`.

Every result carries a `lossiness` list stating what the format could not draw. Mermaid strips shape/comment characters from mindmap labels and encodes `"`, `#`, and `|` in flowchart labels.

## Where results go

- The **primary** (first configured) provider's content is returned inline to the model or printed by `/visualize`.
- When `outputDir` is enabled, every provider's output is written as `<timestamp>-<title-slug>.<provider>.<ext>` with exclusive create (`wx`) — existing files are never overwritten; a name collision gets a `-2`, `-3`, … suffix.
- Default directory: `~/.casper/visualizations/<project-name-slug>/`, **outside the code workspace**. Canonical destinations inside the workspace are refused, including symlinks. Relative user paths resolve under the user's home, not the shell cwd.
- Artifact creation/cleanup is bound to an opened, validated directory descriptor with POSIX `openat`/`mkdirat`/`unlinkat`, including creation of missing output directories. A tiny fixed-arity C bridge (`artifacts.c`) is compiled once per process by Bun's built-in TinyCC; no compiler package or external service is installed. This avoids parent-symlink swaps between validation and creation and correctly handles macOS arm64's variadic ABI. Files are owner-only. Filesystem artifact output currently requires macOS or Linux; other platforms must set `outputDir: false` for inline rendering. macOS is tested here; Linux uses the supported POSIX path but has not been acceptance-tested in this environment.

## Configuration

```yaml
# ~/.casper/config.yaml or ~/.casper/profiles/<profile>/config.yaml
visualize:
  providers: [mermaid, mindmesh]   # preference order; first is primary
  outputDir: ~/diagrams            # path (~ expands) or false to keep results in-conversation only
```

Precedence: global → profile → project. `providers` may be set at any layer. `outputDir` accepts a path only from user-owned global/profile files; a project's `.casper/project.yaml` may only set `outputDir: false`. This prevents a checked-in configuration from redirecting writes. Unknown provider names are reported at startup and ignored; if none remain usable, startup fails.

## Using it

- Prompts classified with the `visualize` intent (`map out`, `diagram`, `mind map`, `flowchart`, `visualize`, `draw`, `chart`, `dependency graph`) are **read** mode with no verification, and expose the `visualize` tool for that turn. Other prompts do not carry it.
- The `visualize` tool accepts either a model-authored `graph`, or `source: "repo"` with an optional project-relative `scope` to build a deterministic relative-import dependency graph. Results are bounded by the shared 16 KiB / 50-item capability envelope with truncation disclosed.
- `/visualize` prints providers and the artifact directory. `/visualize repo [directory]` renders the dependency graph locally and never starts a model session.

## Repository dependency graph

`buildRepoGraph` scans `.ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs` files (not `.d.ts`), skipping `node_modules`, `.git`, `dist`, `build`, `out`, `coverage`, `.next`, `.turbo`, `.cache`, `vendor`, `target`, `__pycache__`, dot-directories, symlinks, and files over 1 MiB. An explicitly requested scope is always scanned. Imports are matched by a two-phase scan (quoted specifier, then an `import … from` / `export … from` / `import()` / `require()` anchor within the preceding 512 bytes); only relative specifiers are resolved, trying exact path, `.js`→`.ts` siblings, source extensions, then `index.*`. Package imports, unresolved specifiers, and files over 1 MiB are counted in the notes, not drawn.

Limits: 2000 files (partial graphs are flagged); more than 120 file nodes collapses to directory nodes with `N imports` edge labels. Aliased paths, dynamic specifiers, and non-JS/TS languages are not resolved.

## Limits

- No Graphviz provider, no image rendering, and no interactive MindMesh session; opening the JSON in MindMesh is a manual import.
- Model-authored graphs describe the model's understanding; Casper validates shape, not truth. The repo graph is deterministic but regex-based.
- Node notes are not drawn by Mermaid. Groups are not drawn in mindmaps or MindMesh.
- The tool is exposed only when the request is classified as visualization; classification is lexical, not a general natural-language parser. Explicit modification requests such as “fix the chart export” retain verification, while “show me a diagram of the test flow” is read-only.
- This is not an OS sandbox: a process with the same user's permissions can still move whole open directories, mutate files independently, or tamper with Casper itself.
