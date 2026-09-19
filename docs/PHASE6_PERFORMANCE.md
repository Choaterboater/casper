# Phase 6 — Debug and Performance Follow-up

Scope: Casper's visualization module (`src/visualize/`). Local measurements only; no external model or server involved. Nothing committed or pushed.

## Defects reproduced and fixed

Each was first captured as a failing regression test, then fixed.

| # | Defect | Cause | Fix | Test |
| --- | --- | --- | --- | --- |
| 1 | `buildRepoGraph` **crashed** ("Spread syntax requires ...iterable") when any scanned file exceeded 1 MiB. | Oversized files were skipped before their `edgesByFile` entry was created; later lookups dereferenced `undefined`. | Every file gets an entry first; oversized files are counted and disclosed as `N file(s) over 1 MiB were not parsed for imports.` | `regression: oversized sources are skipped without crashing…` |
| 2 | Concurrent (or same-millisecond) renders with the same title **failed with EEXIST**. | Artifact names were `<timestamp>-<slug>` only; exclusive create correctly refused to overwrite, but the whole render then threw. | Retry with `-2`, `-3`, … suffix on EEXIST; partially written files from a failed attempt are removed. Originals are never touched. | `regression: concurrent renders with identical titles…`; router test updated to assert suffixing |
| 3 | **Invalid Mermaid** from titles containing `:`/`"` (YAML front matter) and from labels that stripped to nothing (`root(((unnamed)))`). | Front-matter title was emitted raw; the empty-label placeholder contained parentheses that mindmap syntax treats as shape markers. | Title is emitted as a JSON string (valid YAML); placeholder is `unnamed`. | `regression: Mermaid titles with colons and labels that strip to nothing…` |
| 4 | **Quadratic import matching**: a 1 MiB file with many `import` keywords and no string literal took ~1.9 s. | `[^'"]*?` inside the combined regex backtracked from every `import` to end of file. | Two-phase scan: backtrack-free quoted-string match, then a bounded 512-byte look-behind window for the `import`/`export … from`/`import(`/`require(` anchor. Output on Casper/src is identical (34 nodes / 105 edges). | `performance: import matching is linear on adversarial sources` (< 500 ms budget) |
| 5 | `/visualize repo` could **not be cancelled** by `close()`; a scan in flight would finish and write artifacts after shutdown began. | No abort signal was threaded through the local command path. | `visualizationAbort` controller, aborted in `close()`, passed to `buildRepoGraph` and `router.render`. | `regression: closing during /visualize repo cancels the scan…` |

## Optimizations

- **Repository scan** reads files in batches of 32 instead of strictly sequentially (`lstat` + `readFile` per file), with the abort check per batch.
- **MindMesh provider** no longer computes the spanning tree twice per render (`projectMindMeshMap` returns the tree it used); tree-edge label lookup uses a `Set` instead of `Array.includes` (O(E) instead of O(E²)).
- **`spanningTree`** BFS uses an index cursor rather than `Array.shift()`.

## Measurements

Medians, local machine, same session, before → after (`n` = 3 for scans, 20 for renders). These describe Casper's own code paths, not any external tool.

| Workload | Before | After |
| --- | --- | --- |
| Adversarial 1 MiB source (2500 `import` lines, no literals) | 1919.01 ms | **0.49 ms** |
| Adversarial 900 KB source (300 000 adjacent quoted strings) | — (not measured before) | 25.85 ms |
| Synthetic repo, 2000 files / 40 directories, full scan + graph | 293.42 ms | **51.96 ms** (~82% lower) |
| Casper `src/` scan (34 files) | 4.80 ms | 2.16 ms |
| `spanningTree`, 400 nodes / 800 edges | 0.26 ms | 0.26 ms |
| Mermaid flowchart, 400 / 800 | 0.41 ms | 0.46 ms (noise) |
| MindMesh document, 400 / 800 | 1.72 ms | 1.34 ms |

Rendering was already sub-2 ms at the IR limits; the meaningful wins are the pathological-input fix and the scan batching.

## Validation

- `bun run check`: TypeScript passed, **137 tests / 794 assertions** (Phase 6 start: 132 / 781).
- Phase 6 suites repeated three times: **20 tests / 198 assertions** each, all passed.
- `git diff --check` clean.
- Parser rewrite verified against Casper's own tree: identical node/edge counts and notes before and after.

## Remaining limits (unchanged)

- Import detection is still regex-based; the anchor window is 512 bytes, so an import statement whose specifier is more than 512 bytes after the `import` keyword is not matched. Aliases and dynamic specifiers are not resolved.
- Symlinked scope directories are resolved lexically, not via `realpath`; symlinks inside the tree are skipped.
- Artifact suffix retry is capped at 1000 attempts per render.
- Independent Standards/Spec review of Phase 6 has still not been run.
