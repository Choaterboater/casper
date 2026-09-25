# mcp-server-kit

The tool catalog of a small MCP server that exposes a read-only in-memory workspace.

## Conventions

- One tool per file in `src/tools/`, registered in `src/catalog.ts`. Catalog order is discovery order
  and stays alphabetical by tool name.
- Every tool declares a JSON Schema `inputSchema` with `additionalProperties: false`, and MCP
  `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) set explicitly.
- Tools never throw for bad input or missing data: they return `toolError(message)` from `src/result.ts`
  (`isError: true`). Arguments are validated with `src/validate.ts`.
- Output is bounded: no tool returns more than `MAX_OUTPUT_CHARS` (4000) characters of text. A very long
  line is shortened (ending in `…`) rather than left out, so a result never loses its first entry.
