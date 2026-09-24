# net-mcp-router

An MCP server for network devices that uses **router-style discovery**: clients see only three
router tools, and find the device tools through them. This keeps the tool list small no matter how
many device tools exist. Device data comes from an injected inventory; tests use synthetic data.

## Router tools (`src/router.ts`)

- `find_tool { query, include_schema? }`: device tools whose name or description contains every query
  word (case-insensitive), best match first; JSON text `[{ name, description, readOnly, inputSchema? }]`.
- `invoke_read_tool { name, arguments }`: runs a device tool only when it is read-only.
- `invoke_tool { name, arguments, confirm }`: runs any device tool; requires `confirm: true`.

## Device tools (`src/tools/`)

- One tool per file, registered in `src/tools/index.ts` (alphabetical).
- Each declares `inputSchema` (validated with `src/validate.ts`, `additionalProperties: false`),
  explicit MCP `annotations`, and returns `toolText`/`toolError` from `src/result.ts`; never throws.
- Results that list things are JSON text, bounded (at most 50 items, with `total` and `truncated`),
  and never exceed `MAX_OUTPUT_CHARS`.
- Tools only read from the `Inventory` passed in; they never reach a device directly.
