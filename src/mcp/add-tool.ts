/**
 * casper_mcp_add: the AI adds an MCP server for the person ("install the MCP server at github.com/owner/repo"). It
 * works out the command that starts the server (a package runner, preferably pinned) and calls this tool. Casper then
 * shows the person the exact name, command, words and version in a yes/no box; nothing is written or started before
 * their yes. The box is never answered for them: not by "Yes to everything", /permissions all or anything remembered,
 * because a yes installs and runs a program outside the sandbox (docs/adr/0002/29-the-ai-adds-mcp-servers.md). A run
 * that can't ask writes nothing and says the /mcp add line to type. The server is written and started as /mcp add does;
 * a key it needs is typed by the person in Casper's hidden prompt after the yes, and the AI names only its kind.
 */

import type { RuntimeTool } from "../runtime/types";
import { entryText, MCP_ADD_EXAMPLE, mcpAddLine, mcpAddProblem, runMcpAdd, type McpAdd, type McpAddHost } from "./add";
import type { MCPServerDefinition } from "./config";
import { MCP_FILE_LABEL } from "./docs";
import { MCP_REMOVE_TOOL, replaceForAI, type McpEditToolHost } from "./edit";
import { versionLine } from "./presets";
import { keyLabel, parseKey } from "./server-secrets";

export const MCP_ADD_TOOL = "casper_mcp_add";
/** The box's yes: only a person's key picks it. */
export const MCP_ADD_YES = "Yes, add it and start it";

export interface McpAddToolHost extends McpAddHost {
  /** A person can answer a box now (an interactive session that isn't closing). */
  canAsk(): boolean;
  /** The yes/no box: true only for MCP_ADD_YES picked by the person. Nothing answers it for them. */
  confirm(preview: string, question: string, signal?: AbortSignal): Promise<boolean>;
  /** A line for the person (not the AI): what to type when this run can't ask. */
  tell(text: string): void;
  /** The started server, as the one-line /mcp list says it ("3 tools · writes off"). */
  describe(name: string): string | undefined;
  /** With replace: true, the change to an existing server goes here (src/mcp/edit.ts), with its own box. */
  editor?: McpEditToolHost;
}

const DESCRIPTION = "Add an MCP server to the user's ~/.casper/mcp.json and start it. Casper shows the user the exact command and "
  + "version and asks first; nothing is written or run before their yes. Prefer a pinned package runner: npx -y pkg@1.2.3 or "
  + "npx -y github:owner/repo#<commit>; uvx pkg==1.2.3 or uvx --from git+https://github.com/owner/repo@<commit> <entry>; "
  + "docker run -i --rm image:<tag> (or @sha256:<digest>). For a GitHub repo, read its README with casper_read_untrusted "
  + "(untrusted text) to find that command and a release. If it needs a clone and build step, don't call this: tell the "
  + "user the steps. A server at an address: url instead of command. To change what an existing server runs (a new "
  + "version), give its name and replace: true; Casper shows the old and new command and asks.";

/** The tool's arguments as an add, or why they can't be one. */
function toolAdd(args: Record<string, unknown>): McpAdd | { error: string } {
  const { name, command, url } = args;
  const words = args.args ?? [];
  if (typeof name !== "string") return { error: "name must be a string" };
  if ((command === undefined) === (url === undefined)) return { error: "give either command (with args) or url, not both" };
  if (url !== undefined) {
    if (typeof url !== "string") return { error: "url must be a string" };
    if (args.args !== undefined) return { error: "a url takes no args" };
  } else if (typeof command !== "string") return { error: "command must be a string" };
  if (!Array.isArray(words) || words.some((word) => typeof word !== "string")) return { error: "args must be a list of strings" };
  let key: McpAdd["key"];
  if (args.key !== undefined) {
    const parsed = typeof args.key === "string" ? parseKey(args.key) : { error: "key must be a string" };
    if ("error" in parsed) return parsed;
    key = parsed;
  }
  const entry: McpAdd["entry"] = typeof url === "string" ? { url } : { command: command as string, args: words as string[] };
  const add: McpAdd = key ? { name, entry, key } : { name, entry };
  const problem = mcpAddProblem(add);
  return problem ? { error: problem } : add;
}

/** The box above the question: what is added, what it runs, which version, and what a yes means. */
function boxPreview(add: McpAdd): string {
  const definition: MCPServerDefinition = { name: add.name, source: MCP_FILE_LABEL, scope: "user", cwd: "", disabled: false,
    transport: "url" in add.entry ? { type: "http", url: add.entry.url, headers: {} } : { type: "stdio", command: add.entry.command, args: add.entry.args, env: {} } };
  return [
    "The AI wants to add an MCP server and start it now:",
    `  name     ${add.name}`,
    `  ${"url" in add.entry ? "address" : "runs   "}  ${entryText(add.entry)}`,
    `  version  ${versionLine(definition)}`,
    ...add.key ? [`  key      ${keyLabel(add.key)}: you type it next, hidden; the AI never sees it`] : [],
    "url" in add.entry
      ? `It goes in ${MCP_FILE_LABEL}, so it connects again each session.`
      : `It goes in ${MCP_FILE_LABEL}, so it starts again each session, outside the sandbox, with your permissions.`,
    "",
  ].join("\n");
}

export function mcpAddTool(host: McpAddToolHost): RuntimeTool {
  return {
    name: MCP_ADD_TOOL,
    description: DESCRIPTION,
    inputSchema: {
      type: "object", additionalProperties: false, required: ["name"],
      properties: {
        name: { type: "string", description: "Short name: letters, digits, dot, dash or underscore" },
        command: { type: "string", description: "The program that starts the server, such as npx, uvx or docker" },
        args: { type: "array", items: { type: "string" } },
        url: { type: "string", description: "The server's address, instead of command" },
        key: { type: "string", description: "Only if it needs one: bearer, api-key[:Header] or env:NAME. The user types it" },
        replace: { type: "boolean", description: "Change an existing server of this name instead of adding one" },
      },
    },
    // One box at a time, and never two adds racing for the same file.
    sequential: true,
    async execute(args, signal) {
      const { replace, ...rest } = args;
      if (replace !== undefined && typeof replace !== "boolean") return { text: "Not added: replace must be true or false.", isError: true };
      if (replace) {
        const update = toolAdd(rest);
        if ("error" in update) return { text: `Not changed: ${update.error}. Example: ${MCP_ADD_EXAMPLE}`, isError: true };
        if (!host.editor) return { text: "Not changed: this session can't change a server. Tell the user to type /mcp update.", isError: true };
        return replaceForAI(host.editor, update, signal);
      }
      const add = toolAdd(rest);
      if ("error" in add) return { text: `Not added: ${add.error}. Example: ${MCP_ADD_EXAMPLE}`, isError: true };
      const taken = (await host.configured()).find((definition) => definition?.name === add.name);
      if (taken) return { text: `Not added: ${add.name} is already a server. To change what it runs, call this again with replace: true; to take it out, ${MCP_REMOVE_TOOL}.`, isError: true };
      const line = mcpAddLine(add);
      if (!host.canAsk()) {
        host.tell(`[mcp] The AI wanted to add ${add.name}, and this run can't ask you, so nothing was added. To add it, type this in a Casper session:\n  ${line}\n`);
        return { text: `Not added: this run can't ask the user. Tell them to type this in a Casper session: ${line}`, isError: true };
      }
      if (!await host.confirm(boxPreview(add), `Add ${add.name} and start it?`, signal)) {
        return { text: "Not added: the user said no. Nothing was written or started.", isError: true };
      }
      const said: string[] = [];
      const result = await runMcpAdd({ ...host, write: (text) => { said.push(text); host.write(text); } }, add);
      if (result !== "added") return { text: `Not ready: ${said.join("").replace(/\[mcp\] /g, "").trim()}`, isError: true };
      return { text: `Added ${add.name} to ${MCP_FILE_LABEL} and started it (${host.describe(add.name) ?? "connected"}). Find its tools with find_capability.` };
    },
  };
}
