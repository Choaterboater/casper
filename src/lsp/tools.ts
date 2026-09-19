import type { RuntimeTool } from "../runtime/types";
import { boundCapabilityResult } from "../capabilities/result";
import type { ConfirmRename, LSPManager } from "./manager";

export function lspTools(manager: LSPManager, confirm: ConfirmRename): RuntimeTool[] {
  if (!manager.status().some((server) => server.state === "ready")) return [];
  return [{
    name: "lsp",
    description: "Language-aware diagnostics, document/workspace symbols, definition, references, or rename. Requires a connected server (/lsp). Paths are project-relative; line and character are zero-based UTF-16. Rename requires exact interactive approval and reports post-edit diagnostics. Only fresh diagnostics verify current content; unversioned/timeout/unavailable never mean clean. Output capped at 16 KiB/50 items with truncation disclosed.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["server", "operation"],
      properties: {
        server: { type: "string" }, operation: { type: "string", enum: ["diagnostics", "symbols", "workspaceSymbols", "definition", "references", "rename"] },
        path: { type: "string" }, line: { type: "integer", minimum: 0 }, character: { type: "integer", minimum: 0 },
        query: { type: "string" }, newName: { type: "string" },
      },
    },
    async execute(args, signal, context) {
      try {
        if (Object.keys(args).some((key) => !["server", "operation", "path", "line", "character", "query", "newName"].includes(key))
          || typeof args.server !== "string" || typeof args.operation !== "string") throw new Error("Invalid LSP arguments");
        const operation = args.operation;
        if (!["diagnostics", "symbols", "workspaceSymbols", "definition", "references", "rename"].includes(operation)) throw new Error("Unknown LSP operation");
        if (operation !== "workspaceSymbols" && (typeof args.path !== "string" || !args.path)) throw new Error("LSP path required");
        if (args.query !== undefined && typeof args.query !== "string") throw new Error("Invalid symbol query");
        let position;
        if (["definition", "references", "rename"].includes(operation)) {
          if (typeof args.line !== "number" || typeof args.character !== "number" || !Number.isSafeInteger(args.line) || !Number.isSafeInteger(args.character) || args.line < 0 || args.character < 0) throw new Error("Zero-based LSP position required");
          position = { line: args.line, character: args.character };
        }
        let result: unknown;
        if (operation === "rename") {
          if (typeof args.newName !== "string") throw new Error("Rename name required");
          result = await manager.rename(args.server, args.path as string, position!, args.newName, confirm, context?.withFileLocks, signal);
        } else if (operation === "diagnostics") result = await manager.diagnostics(args.server, args.path as string, signal);
        else result = await manager.query(args.server, operation as "symbols" | "workspaceSymbols" | "definition" | "references", { path: args.path as string | undefined, position, query: args.query as string | undefined }, signal);
        return { text: JSON.stringify(boundCapabilityResult(result)) };
      } catch (error) {
        return { text: JSON.stringify(boundCapabilityResult({ isError: true, error: error instanceof Error ? error.message : "LSP operation failed" })), isError: true };
      }
    },
  }];
}
