import { createHash } from "node:crypto";
import { isRecord } from "../mcp/config";
import type { MCPManager, MCPTool } from "../mcp/manager";
import type { RuntimeTool } from "../runtime/types";
import { boundCapabilityResult, capabilityErrorResult, NotExecutedError, type BoundedCapabilityResult } from "./result";
import { indexWords, termScore, tokenize } from "./search";
import type { CompiledValidator } from "./validate";

export type CapabilitySafety = "read" | "diagnostic" | "write" | "destructive" | "exec" | "external-action";
export interface CapabilityDescriptor {
  id: string;
  source: string;
  name: string;
  description: string;
  tags: string[];
  safety: CapabilitySafety;
  schemaRef: string;
}
interface Capability {
  descriptor: CapabilityDescriptor;
  tool: MCPTool;
  runtimeName: string;
  fingerprint: string;
  router: boolean;
  schemaBytes: number;
  nameWords: Set<string>;
  descriptionWords: Set<string>;
  validate?: CompiledValidator;
}
/** One page of the `find_capability({ query: "*" })` listing. */
export interface CapabilityListPage {
  total: number;
  shown: string;
  items: { id: string; safety: CapabilitySafety; about: string }[];
  routers?: { server: string; hint: string }[];
  next_cursor?: string;
}
/** Ask the user about one exact call. It resolves true only on their yes; it may throw NotExecutedError
 * when nobody can be asked (a one-shot run), so the model is never told "you said no" by mistake. */
export type ConfirmCapability = (call: {
  capability: CapabilityDescriptor; arguments: Record<string, unknown>;
}, signal?: AbortSignal) => Promise<boolean>;

// Ajv is loaded only on the first call, so local commands never pay for it.
let validatorModule: typeof import("./validate") | undefined;
let validatorLoad: Promise<NonNullable<typeof validatorModule>> | undefined;
const MAX_SCHEMA_BYTES = 12_000;
const MAX_DIRECT_SCHEMA_BYTES = 32_000;
function requireSupportedSchema(capability: Capability): void {
  if (capability.schemaBytes > MAX_SCHEMA_BYTES) throw new NotExecutedError("schema not supported: over the 12 KB limit");
}
/** A cancelled call that was never sent reads "Not executed (cancelled)", whatever the abort reason was. */
function notCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new NotExecutedError("cancelled");
}
const MAX_ARGUMENT_BYTES = 16_384;

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
/** Plain code-point order, the same on every machine. */
function order(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
const LIST_PAGE_ITEMS = 50;
const LIST_PAGE_BYTES = 12_000;
const LIST_ABOUT_CHARS = 80;
const CURSOR_PATTERN = /^\d{1,9}\.\d{1,6}$/;
const ROUTER_HINT = "This server has its own search. Call its find_tool with a few words; it cannot list everything.";
const EMPTY_SEARCH_HINT = 'Nothing matched. Try one plain word (like site or vlan), or query "*" to list every tool.';
function safety(tool: MCPTool): CapabilitySafety {
  // Names can only tighten policy, never grant read permission.
  if (tool.name === "invoke_tool" || tool.name === "invoke_tools_batch" || tool.annotations?.destructiveHint === true) return "destructive";
  if (/\b(delete|destroy|remove|reset|reboot|wipe)\b/.test(tool.name.replaceAll("_", " "))) return "destructive";
  if (/\b(exec|execute|shell|run)\b/.test(tool.name.replaceAll("_", " "))) return "exec";
  if (/\b(create|update|set|write|deploy)\b/.test(tool.name.replaceAll("_", " "))) return "write";
  const declared = tool._meta?.["casper/safety"];
  if (typeof declared === "string" && ["diagnostic", "write", "destructive", "exec", "external-action"].includes(declared)) return declared as CapabilitySafety;
  return tool.annotations?.readOnlyHint === true ? "read" : "external-action";
}

/** Index locally; send schemas only for selected tools or explicit inspection. */
export class CapabilityBroker {
  private capabilities = new Map<string, Capability>();
  private indexedRevision = -1;
  private readonly closed = new AbortController();
  constructor(private readonly manager: MCPManager, private readonly confirm?: ConfirmCapability) {}

  async prepare(task: string): Promise<RuntimeTool[]> {
    if (this.closed.signal.aborted) return [];
    await this.manager.prepare();
    this.sync();
    return this.toolsForTask(task);
  }

  search(query: string, limit = 5): CapabilityDescriptor[] {
    this.sync();
    return this.rank(query, { prefix: true }).slice(0, Math.min(10, Math.max(1, limit))).map((c) => structuredClone(c.descriptor));
  }

  /**
   * One page of every connected tool, sorted by server then tool name: at most 50 short lines and
   * about 12 KB. The cursor is `<catalog revision>.<offset>`, so a page from an older tool list is refused.
   */
  list(cursor?: string): CapabilityListPage {
    this.sync();
    let offset = 0;
    if (cursor !== undefined) {
      if (!CURSOR_PATTERN.test(cursor)) throw new NotExecutedError('bad arguments: field "cursor" is not valid; use next_cursor from the last page');
      const [revision, start] = cursor.split(".").map(Number) as [number, number];
      if (revision !== this.indexedRevision) throw new NotExecutedError("old page", 'The tool list changed since that page. Start again with query "*".');
      offset = start;
    }
    const all = [...this.capabilities.values()].sort((a, b) => order(a.descriptor.source, b.descriptor.source) || order(a.descriptor.name, b.descriptor.name));
    if (offset > all.length || (offset === all.length && offset > 0)) throw new NotExecutedError('bad arguments: field "cursor" is not valid; use next_cursor from the last page');
    const routers = [...new Set(all.filter((c) => c.router).map((c) => c.descriptor.source))].map((server) => ({ server, hint: ROUTER_HINT }));
    const page: CapabilityListPage = { total: all.length, shown: "", items: [], ...(routers.length ? { routers } : {}) };
    const room = (next: number) => {
      const draft = { ...page, shown: `${offset + 1}-${next}`, next_cursor: `${this.indexedRevision}.${next}` };
      return Buffer.byteLength(JSON.stringify(draft)) <= LIST_PAGE_BYTES;
    };
    for (const capability of all.slice(offset, offset + LIST_PAGE_ITEMS)) {
      const { id, safety, description } = capability.descriptor;
      page.items.push({ id, safety, about: (description.split(/\r?\n/, 1)[0] ?? "").trim().slice(0, LIST_ABOUT_CHARS) });
      // Always keep at least one line, so every page moves forward.
      if (page.items.length > 1 && !room(offset + page.items.length)) { page.items.pop(); break; }
    }
    const end = offset + page.items.length;
    page.shown = page.items.length ? `${offset + 1}-${end}` : "0";
    if (end < all.length) page.next_cursor = `${this.indexedRevision}.${end}`;
    return page;
  }

  describe(id: string): { capability: CapabilityDescriptor; inputSchema: MCPTool["inputSchema"] } {
    this.sync();
    const capability = this.get(id);
    requireSupportedSchema(capability);
    return structuredClone({ capability: capability.descriptor, inputSchema: capability.tool.inputSchema });
  }

  /**
   * Run one capability call. Every refusal before the call is sent throws NotExecutedError, so the
   * model reads "Not executed (…)" and never "Complete result". The steps keep this order; later
   * packages fill the marked seams in place:
   *   size check -> validate (WP3) -> hidden/argGuard (WP4) -> secret-marker gate (WP6)
   *   -> approval plan (WP2) -> call (call clock) -> scrub (WP6) -> bound the result.
   */
  async invoke(id: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<BoundedCapabilityResult> {
    const combined = signal ? AbortSignal.any([signal, this.closed.signal]) : this.closed.signal;
    notCancelled(combined);
    this.sync();
    const capability = this.get(id);
    // 1. Size check.
    if (!isRecord(args) || Buffer.byteLength(JSON.stringify(args)) > MAX_ARGUMENT_BYTES) throw new NotExecutedError("arguments over 16 KB");
    const frozenArgs = structuredClone(args);
    requireSupportedSchema(capability);
    // 2. Validate (WP3 seam: field-named argument errors extend "bad arguments").
    // Also validate fallback calls; a generic invocation schema is not permission
    // to bypass the target tool's actual schema.
    let checked: ReturnType<CompiledValidator>;
    try {
      if (!capability.validate) {
        validatorModule ??= await (validatorLoad ??= import("./validate"));
        capability.validate ??= validatorModule.compileInputSchema(capability.tool.inputSchema);
      }
      checked = capability.validate(frozenArgs);
    } catch { throw new NotExecutedError("schema not supported"); }
    // A first-use import yields: do not ask for approval using a cancelled call
    // or stale catalog, even before the existing post-approval identity check.
    notCancelled(combined);
    this.sync();
    if (this.get(id).fingerprint !== capability.fingerprint) throw new NotExecutedError("tool changed; search again");
    if (!checked.valid) {
      // Field names only; the values the model sent are never repeated.
      const { reason, next } = validatorModule!.argumentProblem(id, checked.problems);
      throw new NotExecutedError(reason, next);
    }
    // 3. Hidden capabilities and argument guards (WP4 seam).
    // 4. Hidden-secret marker gate (WP6 seam).
    // 5. Approval (WP2 seam: the approval plan replaces this block).
    if (capability.descriptor.safety !== "read") {
      if (!this.confirm) throw new NotExecutedError("needs your approval, and this run cannot ask");
      const approved = await this.confirm({
        capability: structuredClone(capability.descriptor), arguments: structuredClone(frozenArgs),
      }, combined);
      notCancelled(combined);
      if (!approved) throw new NotExecutedError("you said no");
    }
    notCancelled(combined);
    this.sync();
    if (this.get(id).fingerprint !== capability.fingerprint) throw new NotExecutedError("tool changed; search again");
    // 6. Call, under the per-server call clock (the manager owns it; WP2 pauses it through onClock).
    const raw = await this.manager.call(capability.descriptor.source, capability.tool.name, frozenArgs, combined);
    // 7. Scrub device secrets from the raw result (WP6 seam).
    // 8. Bound: per-list limits, the next-page cursor kept, duplicate text dropped.
    return boundCapabilityResult(raw, 16_384, 50, { mcp: true });
  }

  close(): Promise<void> {
    this.closed.abort();
    this.capabilities.clear();
    return this.manager.close();
  }

  private sync(): void {
    const revision = this.manager.catalogRevision;
    if (revision === this.indexedRevision) return;
    const next = new Map<string, Capability>();
    if (!this.closed.signal.aborted) for (const { server, generation, tools } of this.manager.catalog()) {
      const routed = tools.some((tool) => tool.name === "find_tool") && tools.some((tool) => tool.name === "invoke_read_tool");
      for (const tool of tools) {
        const id = `mcp:${encodeURIComponent(server)}:${encodeURIComponent(tool.name)}`;
        const descriptor: CapabilityDescriptor = {
          id, source: server, name: tool.name, description: (tool.description ?? "").slice(0, 1024),
          tags: [], safety: safety(tool), schemaRef: id,
        };
        const tags = tool._meta?.tags;
        if (Array.isArray(tags)) descriptor.tags = tags.filter((tag): tag is string => typeof tag === "string").slice(0, 8).map((tag) => tag.slice(0, 64));
        next.set(id, {
          descriptor, tool, runtimeName: `mcp_${tool.name.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 24)}_${hash(id).slice(0, 24)}`,
          fingerprint: `${generation}:${hash(JSON.stringify(tool))}`,
          router: routed && ["find_tool", "invoke_read_tool", "invoke_tool"].includes(tool.name),
          // Budget the escaped representation too, so lossless schema inspection
          // fits the result envelope without truncating enum/required arrays.
          schemaBytes: Buffer.byteLength(JSON.stringify(JSON.stringify(tool.inputSchema))),
          nameWords: indexWords(`${descriptor.name} ${descriptor.source} ${descriptor.tags.join(" ")}`),
          descriptionWords: indexWords(descriptor.description),
        });
      }
    }
    this.capabilities = next;
    this.indexedRevision = revision;
  }

  private get(id: string): Capability {
    const capability = this.capabilities.get(id);
    if (!capability) throw new NotExecutedError("unknown capability; use find_capability");
    return capability;
  }

  /** Plural-aware word match. `prefix` (search only) also lets a 5+ letter word match the start of a name word. */
  private rank(query: string, options: { prefix?: boolean } = {}): Capability[] {
    const terms = tokenize(query);
    return [...this.capabilities.values()].map((capability) => {
      return { capability, score: terms.reduce((score, term) => score + termScore(term, capability.nameWords, capability.descriptionWords, options), 0) };
    }).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score || a.capability.descriptor.id.localeCompare(b.capability.descriptor.id))
      .map(({ capability }) => capability);
  }

  private toolsForTask(task: string): RuntimeTool[] {
    if (!this.manager.status().length) return [];
    // A call that may need approval runs one at a time, so two approval prompts never race.
    const wrap = (name: string, description: string, inputSchema: Record<string, unknown>, execute: RuntimeTool["execute"], sequential = false): RuntimeTool => ({
      name, description, inputSchema, ...(sequential ? { sequential } : {}),
      execute: async (args, signal) => {
        try { return await execute(args, signal); }
        catch (error) {
          // Local errors are controlled strings; raw transport errors are removed by the manager.
          // A refusal reads "Not executed (…)", never "Complete result".
          return { text: JSON.stringify(capabilityErrorResult(error)), isError: true };
        }
      },
    });
    const tools: RuntimeTool[] = [
      wrap("find_capability", 'Search connected MCP tools by words, or use query "*" to list every tool, 50 at a time (pass next_cursor to see more). Or give one exact id to get its full input schema as a JSON string in inputSchemaJson (parse it before calling). Leave unused fields empty. No server calls. Results stay under 16 KB. If nothing is connected, ask the user to /mcp connect a server.', {
        type: "object", properties: { query: { type: "string" }, id: { type: "string" }, cursor: { type: "string" } }, additionalProperties: false,
      }, async (args) => {
        const id = typeof args.id === "string" ? args.id.trim() : "";
        const query = typeof args.query === "string" ? args.query.trim() : "";
        const cursor = typeof args.cursor === "string" ? args.cursor.trim() : "";
        if (id && query) throw new NotExecutedError("bad arguments", 'Give either "query" or "id", not both.');
        if (!id && !query) throw new NotExecutedError("bad arguments", 'Give a "query" (words, or "*") or an exact "id".');
        if (cursor && query !== "*") throw new NotExecutedError('bad arguments: field "cursor" only works with query "*"');
        if (query === "*") {
          // The page caps itself at 50 lines and 12 KB; the result bound is only a backstop.
          return { text: JSON.stringify(boundCapabilityResult(this.list(cursor || undefined), 16_384, 200)) };
        }
        const found = id ? { id, inputSchemaJson: JSON.stringify(this.describe(id).inputSchema) } : this.search(query);
        const result = Array.isArray(found) && found.length === 0 ? { matches: [], hint: EMPTY_SEARCH_HINT } : found;
        return { text: JSON.stringify(boundCapabilityResult(result)) };
      }),
      wrap("call_capability", "Call a capability by exact id and arguments after inspecting its schema with find_capability. Same safety checks as direct tools. Results bounded to 16 KB and 50 items per list; next_cursor is always kept. Never automatically retry consequential calls.", {
        type: "object", properties: { id: { type: "string" }, arguments: { type: "object", additionalProperties: true } }, required: ["id", "arguments"], additionalProperties: false,
      }, async (args, signal) => {
        if (typeof args.id !== "string" || !args.id.trim()) throw new NotExecutedError('bad arguments: field "id" is missing');
        if (!isRecord(args.arguments)) throw new NotExecutedError('bad arguments: field "arguments" must be an object');
        const result = await this.invoke(args.id, args.arguments, signal);
        return { text: JSON.stringify(result), isError: result.isError };
      }, true),
    ];
    // Native routers are intentionally preferred over flattening their catalog.
    const routers = [...this.capabilities.values()].filter((c) => c.router).sort((a, b) => a.descriptor.id.localeCompare(b.descriptor.id));
    const routedServers = new Set(routers.map((c) => c.descriptor.source));
    const candidates = [...routers, ...this.rank(task).filter((c) => !routedServers.has(c.descriptor.source))];
    let schemaBytes = 0;
    for (const capability of candidates) {
      if (tools.length >= 8) break;
      const bytes = capability.schemaBytes;
      if (bytes > MAX_SCHEMA_BYTES || schemaBytes + bytes > MAX_DIRECT_SCHEMA_BYTES) continue;
      schemaBytes += bytes;
      tools.push(wrap(capability.runtimeName,
        `[${capability.descriptor.safety}; ${capability.descriptor.id}] ${capability.descriptor.description}\nBounded result; non-read calls require confirmation.`,
        structuredClone(capability.tool.inputSchema), async (args, signal) => {
          const result = await this.invoke(capability.descriptor.id, args, signal);
          return { text: JSON.stringify(result), isError: result.isError };
        }, capability.descriptor.safety !== "read"));
    }
    return tools;
  }
}
