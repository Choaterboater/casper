import { createHash } from "node:crypto";
import { isRecord } from "../mcp/config";
import type { MCPManager, MCPTool, ServerPolicy } from "../mcp/manager";
import { accessModelLines, readOnlyLoginReason, writesOffReason } from "../mcp/access";
import { approvalNotes, guardArguments, hasNoPreview, isHidden, tightenSafety } from "../mcp/presets";
import type { RuntimeTool } from "../runtime/types";
import { redactPreview } from "../tui/format";
import { scrubText } from "../secrets/scrub";
import {
  aiConfirm, buildPlan, canPreview, maskText, needsApproval, planLabel, planMode, previewArguments, previewKey, previewSwitchedOff,
  type ApprovalPlan, type LastPreview,
} from "./approval";
import { toolLabel } from "./labels";
import { boundCapabilityResult, capabilityErrorResult, NotExecutedError, OutcomeUnknownError, type BoundedCapabilityResult } from "./result";
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
  /** Left out of search, listings and task tools; a call is refused with this reason. */
  hidden?: string;
  policy: ServerPolicy;
}
/** One page of the `find_capability({ query: "*" })` listing. */
export interface CapabilityListPage {
  total: number;
  shown: string;
  items: { id: string; safety: CapabilitySafety; about: string }[];
  routers?: { server: string; hint: string }[];
  next_cursor?: string;
}
/** The user's answer to one approval: yes, no, or "preview" (run the preview first, then ask again).
 * `true`/`false` mean yes/no. */
export type ApprovalAnswer = boolean | "yes" | "no" | "preview";
/** Ask the user about one exact call. Only their yes runs it; it may throw NotExecutedError when
 * nobody can be asked (a one-shot run), so the model is never told "you said no" by mistake. */
export type ConfirmCapability = (call: {
  capability: CapabilityDescriptor; arguments: Record<string, unknown>;
  /** What the call really runs, its mode and hidden secrets are built from this. */
  plan: ApprovalPlan;
  /** The last preview of the same call on this connection, redacted. */
  lastPreview?: LastPreview;
}, signal?: AbortSignal) => Promise<ApprovalAnswer>;

/** The user can ask for a preview at most this many times for one call; then only yes or no is left. */
const MAX_PREVIEWS = 3;
const LAST_PREVIEW_BYTES = 4096;

/** A preview result as the user may see it: token shapes and config secrets hidden, keys masked, cut short. */
function previewText(raw: unknown): string {
  let text: string;
  if (raw && typeof raw === "object" && "structuredContent" in raw && (raw as { structuredContent?: unknown }).structuredContent !== undefined) {
    text = JSON.stringify((raw as { structuredContent: unknown }).structuredContent);
  } else if (raw && typeof raw === "object" && Array.isArray((raw as { content?: unknown }).content)) {
    text = ((raw as { content: unknown[] }).content).map((block) => block && typeof block === "object" && (block as { type?: unknown }).type === "text"
      ? String((block as { text?: unknown }).text ?? "") : "").filter(Boolean).join("\n");
  } else text = JSON.stringify(raw) ?? "";
  const scrub = (value: string) => scrubText(redactPreview(value)).text;
  return maskText(text.slice(0, LAST_PREVIEW_BYTES * 4), { scrubText: scrub }).slice(0, LAST_PREVIEW_BYTES);
}

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
/** Index locally; send schemas only for selected tools or explicit inspection. */
export class CapabilityBroker {
  private capabilities = new Map<string, Capability>();
  private indexedRevision = -1;
  private readonly closed = new AbortController();
  /** The last preview of each call (server, real tool, arguments without the preview switch), per connection. */
  private previews = new Map<string, LastPreview>();
  /** Per-server lines for find_capability's description (read-only logins, writes off). */
  private modelLines: string[] = [];
  private readonly writesGate: boolean;
  /**
   * `writesGate`: honour each server's writes switch (the app turns this on, so every server starts
   * with writes off). Brokers built directly treat writes as on. Presets, read-only logins and
   * argument guards apply either way; they only ever restrict.
   */
  constructor(private readonly manager: MCPManager, private readonly confirm?: ConfirmCapability, options: { writesGate?: boolean } = {}) {
    this.writesGate = options.writesGate ?? false;
  }

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
    const all = [...this.capabilities.values()].filter((c) => !c.hidden).sort((a, b) => order(a.descriptor.source, b.descriptor.source) || order(a.descriptor.name, b.descriptor.name));
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
    if (capability.hidden) throw new NotExecutedError(capability.hidden);
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
    // 3. Hidden capabilities and argument guards: writes off, a read-only login, a preset's rules.
    if (capability.hidden) throw new NotExecutedError(capability.hidden);
    const { policy } = capability;
    const guard = guardArguments(policy.match, capability.tool, frozenArgs, { writes: this.writes(policy), showOptIn: policy.showOptIn });
    if (typeof guard === "object") throw new NotExecutedError(guard.refuse);
    // 4. Hidden-secret marker gate (WP6 seam).
    // 5. Approval. The call is judged by the real tool behind a router, and the AI can never skip it:
    // confirm/force set to true or a preview switch set to false asks even for a read tool.
    const notes = approvalNotes(policy.match, capability.tool);
    const noPreview = hasNoPreview(policy.match, capability.tool);
    const plan = buildPlan({
      server: capability.descriptor.source, tool: capability.tool.name, label: capability.descriptor.safety,
      schema: capability.tool.inputSchema, arguments: frozenArgs,
      ...(notes.length || noPreview ? { hint: { ...(notes.length ? { executeNote: notes.join(" ") } : {}), ...(noPreview ? { noPreview } : {}) } } : {}),
    });
    const label = planLabel(plan);
    // A router call is judged by the real tools it runs: a write behind a read router is refused
    // like the write tool itself while writes are off (or for a read-only login).
    this.refuseByPolicy(capability, label);
    // The one opt-in: the user let plain Junos show commands run without asking. Anything the AI
    // set to skip a check still asks.
    const optedIn = guard === "allow" && !plan.routed.length && !plan.routerUnclear
      && aiConfirm(plan.arguments).length === 0 && previewSwitchedOff(plan.arguments).length === 0;
    const approved = needsApproval(plan) && !optedIn ? await this.approve(capability, plan, combined) : undefined;
    notCancelled(combined);
    this.sync();
    const current = this.get(id);
    if (current.fingerprint !== capability.fingerprint) throw new NotExecutedError("tool changed; search again");
    // Writes turned off (ctrl+o) while the box was open: the yes no longer counts.
    if (current.hidden) throw new NotExecutedError(current.hidden);
    this.refuseByPolicy(current, label);
    if (typeof guardArguments(current.policy.match, current.tool, frozenArgs, { writes: this.writes(current.policy), showOptIn: current.policy.showOptIn }) === "object") {
      throw new NotExecutedError(writesOffReason(capability.descriptor.source));
    }
    // 6. Call, under the per-server call clock. Only an approved call may carry server questions to the user.
    const raw = await this.manager.call(capability.descriptor.source, capability.tool.name, frozenArgs, combined,
      approved ? { approved: { capabilityId: id, realTool: approved, label } } : {});
    if (planMode(plan) === "preview") this.previews.set(this.previewSlot(capability, plan), { text: previewText(raw), at: Date.now() });
    // 7. Scrub device secrets from the raw result (WP6 seam).
    // 8. Bound: per-list limits, the next-page cursor kept, duplicate text dropped.
    return boundCapabilityResult(raw, 16_384, 50, { mcp: true });
  }

  /**
   * Ask the user until they say yes (returns the real tool name for the approved call) or no (throws).
   * "p" runs the preview, when the tool's own schema declares one, and asks again with its result.
   */
  private async approve(capability: Capability, plan: ApprovalPlan, signal: AbortSignal): Promise<string> {
    if (!this.confirm) throw new NotExecutedError("needs your approval, and this run cannot ask");
    const realTool = plan.routed.length ? plan.routed.map((call) => call.name).join(", ") : plan.tool;
    const slot = this.previewSlot(capability, plan);
    for (let previews = 0; ; previews++) {
      const lastPreview = this.previews.get(slot);
      // After the last allowed preview the box is shown once more, without "p", so the user sees it.
      const shown: ApprovalPlan = previews < MAX_PREVIEWS ? plan : { ...plan, hint: { ...plan.hint, noPreview: true } };
      const answer = await this.confirm({
        capability: structuredClone(capability.descriptor), arguments: structuredClone(plan.arguments),
        plan: structuredClone(shown), ...(lastPreview ? { lastPreview: { ...lastPreview } } : {}),
      }, signal);
      notCancelled(signal);
      if (answer === true || answer === "yes") return realTool;
      if (answer !== "preview" || !canPreview(shown)) break;
      // Only send what Casper itself reads as a preview.
      const previewArgs = previewArguments(plan);
      if (planMode({ ...plan, arguments: previewArgs }) !== "preview") break;
      this.sync();
      if (this.get(capability.descriptor.id).fingerprint !== capability.fingerprint) throw new NotExecutedError("tool changed; search again");
      let text: string;
      try {
        const raw = await this.manager.call(plan.server, plan.tool, previewArgs, signal, {
          approved: { capabilityId: capability.descriptor.id, realTool, label: planLabel(plan) },
        });
        text = previewText(raw);
      } catch (error) {
        notCancelled(signal);
        // The preview failed; the change itself was not sent. Show why, and ask again.
        if (!(error instanceof NotExecutedError || error instanceof OutcomeUnknownError)) throw error;
        text = `The preview failed: ${error.message}`;
      }
      this.previews.set(slot, { text, at: Date.now() });
    }
    throw new NotExecutedError("you said no");
  }

  private previewSlot(capability: Capability, plan: ApprovalPlan): string {
    // The whole fingerprint (connection and tool definition): a reconnect or a changed tool never
    // shows an old preview, even when the preview finished after the tool list changed.
    return `${capability.fingerprint}|${previewKey(plan)}`;
  }

  close(): Promise<void> {
    this.closed.abort();
    this.capabilities.clear();
    return this.manager.close();
  }

  private writes(policy: ServerPolicy): "off" | "on" { return this.writesGate ? policy.writes : "on"; }

  /** The same hiding rule as sync(), applied to the label a call is judged by (a router's real tools). */
  private refuseByPolicy(capability: Capability, label: CapabilitySafety): void {
    const { policy, tool } = capability;
    const server = capability.descriptor.source;
    const access = policy.access?.state ?? "unknown";
    if (access === "read-only" && isHidden(undefined, tool, label, { writes: "on", access })) throw new NotExecutedError(readOnlyLoginReason(server));
    if (isHidden(undefined, tool, label, { writes: this.writes(policy), access: "unknown" })) throw new NotExecutedError(writesOffReason(server));
  }

  private sync(): void {
    const revision = this.manager.catalogRevision;
    if (revision === this.indexedRevision) return;
    const next = new Map<string, Capability>();
    const lines: string[] = [];
    if (!this.closed.signal.aborted) for (const { server, generation, tools } of this.manager.catalog()) {
      const routed = tools.some((tool) => tool.name === "find_tool") && tools.some((tool) => tool.name === "invoke_read_tool");
      const policy = this.manager.policy(server);
      const writes = this.writes(policy);
      const access = policy.access?.state ?? "unknown";
      // Built from the server's name and Casper's parsed state only; never from server text.
      lines.push(...accessModelLines(server, policy.access, writes));
      for (const tool of tools) {
        const id = `mcp:${encodeURIComponent(server)}:${encodeURIComponent(tool.name)}`;
        // A preset can only make the label stricter.
        const safety = tightenSafety(policy.match, tool, toolLabel(tool));
        const descriptor: CapabilityDescriptor = {
          id, source: server, name: tool.name, description: (tool.description ?? "").slice(0, 1024),
          tags: [], safety, schemaRef: id,
        };
        const hidden = access === "read-only" && isHidden(policy.match, tool, safety, { writes: "on", access })
          ? readOnlyLoginReason(server)
          : isHidden(policy.match, tool, safety, { writes, access: "unknown" }) ? writesOffReason(server) : undefined;
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
          ...(hidden ? { hidden } : {}), policy,
        });
      }
    }
    this.capabilities = next;
    this.modelLines = lines.sort(order);
    this.indexedRevision = revision;
    // A reconnect or a changed tool list makes old previews stale.
    this.previews.clear();
  }

  private get(id: string): Capability {
    const capability = this.capabilities.get(id);
    if (!capability) throw new NotExecutedError("unknown capability; use find_capability");
    return capability;
  }

  /** Plural-aware word match. `prefix` (search only) also lets a 5+ letter word match the start of a name word. */
  private rank(query: string, options: { prefix?: boolean } = {}): Capability[] {
    const terms = tokenize(query);
    return [...this.capabilities.values()].filter((capability) => !capability.hidden).map((capability) => {
      return { capability, score: terms.reduce((score, term) => score + termScore(term, capability.nameWords, capability.descriptionWords, options), 0) };
    }).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score || a.capability.descriptor.id.localeCompare(b.capability.descriptor.id))
      .map(({ capability }) => capability);
  }

  private toolsForTask(task: string): RuntimeTool[] {
    if (!this.manager.status().length) return [];
    // Stable per-server lines (sorted, parsed state only), so the prompt stays the same between tasks.
    const serverNotes = this.modelLines.length ? ` ${this.modelLines.join(" ")}` : "";
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
      wrap("find_capability", `Search connected MCP tools by words, or use query "*" to list every tool, 50 at a time (pass next_cursor to see more). Or give one exact id to get its full input schema as a JSON string in inputSchemaJson (parse it before calling). Leave unused fields empty. No server calls. Results stay under 16 KB. If nothing is connected, ask the user to /mcp connect a server.${serverNotes}`, {
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
    const routers = [...this.capabilities.values()].filter((c) => c.router && !c.hidden).sort((a, b) => a.descriptor.id.localeCompare(b.descriptor.id));
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
        // Routers and non-read tools may ask; a read tool asks only when the AI set confirm itself (the app queues those).
        }, capability.descriptor.safety !== "read" || capability.router));
    }
    return tools;
  }
}
