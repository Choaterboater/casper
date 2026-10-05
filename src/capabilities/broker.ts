import { createHash } from "node:crypto";
import { isRecord } from "../mcp/config";
import type { MCPManager, MCPTool, ServerPolicy } from "../mcp/manager";
import { ACCESS_TOOL, accessModelLines, parseAccessCheck, readOnlyLoginReason, writesOffReason } from "../mcp/access";
import { approvalNotes, guardArguments, hasNoPreview, isHidden, tightenSafety } from "../mcp/presets";
import type { RuntimeTool } from "../runtime/types";
import { redactPreview } from "../tui/format";
import { scrubExactValues } from "../secrets/assignments";
import { containsHiddenSecret, scrubText, scrubValue, SECRET_MARKER } from "../secrets/scrub";
import { scrubNote, type ScrubOutcome } from "../secrets/netconan";
import { DOCS_TOOL_NAMES, DOCS_TOOL_NOTE, docsPinned } from "../mcp/docs";
import {
  aiConfirm, buildPlan, canPreview, maskText, needsApproval, planLabel, planMode, previewArguments, previewKey, previewSwitchedOff, sessionAllowed,
  type ApprovalPlan, type LastPreview,
} from "./approval";
import { toolLabel } from "./labels";
import { loginExpired, loginMissing, type LoginTrouble } from "../mcp/network/ask-login";
import { getsLogins, isNetworkProduct, PRODUCT_LABELS, type NetworkProduct } from "../mcp/network/logins";
import {
  asksEveryTime, hitKindsFrom, isRiskyKind, KIND_TEXT, MAX_HITS_PER_SERVER, planKinds, riskier, withHitKinds, type ChangeKind, type RouterHit,
} from "./kinds";
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
  /** A docs tool of a recognised hpe-networking-mcp server: always offered to the model. */
  docs?: true;
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
export type ApprovalAnswer = boolean | "yes" | "no" | "preview" | "yes-session" | "allow-all";
/** Ask the user about one exact call. Only their yes runs it; it may throw NotExecutedError when
 * nobody can be asked (a one-shot run), so the model is never told "you said no" by mistake. */
export type ConfirmCapability = (call: {
  capability: CapabilityDescriptor; arguments: Record<string, unknown>;
  /** What the call really runs, its mode and hidden secrets are built from this. */
  plan: ApprovalPlan;
  /** The last preview of the same call on this connection, redacted. */
  lastPreview?: LastPreview;
  /** The tool's server tags (`_meta`), so the box reads the server's change kind. */
  tool?: Pick<MCPTool, "_meta">;
  /** The product Casper's network server said the one routed tool belongs to (from find_tool). */
  product?: NetworkProduct;
}, signal?: AbortSignal) => Promise<ApprovalAnswer>;

/** A product of Casper's network server had no login: the host asks the person (never the AI) and returns the
 * one line the AI gets back instead of the server's answer. */
export type LoginMissingHandler = (server: string, product: NetworkProduct, signal: AbortSignal, trouble?: LoginTrouble) => Promise<string>;

/** Ask the user whether a change kind that is off by default (firmware, delete, admin) may run on this server. Only
 * their answer counts: allowed for this call only ("once"), for this session on that server (true), or no. */
export type ConfirmKind = (ask: { server: string; kind: ChangeKind; realTool: string }, signal?: AbortSignal) => Promise<boolean | "once">;

/** Hides device secrets in an MCP result before the model sees it. The app passes its shared
 * scrubber (Casper's rules plus netconan when installed); the default is Casper's rules only. */
export interface ResultScrubber {
  scrubValue<T>(value: T, signal?: AbortSignal): Promise<ScrubOutcome<T>>;
}
const BUILT_IN_SCRUBBER: ResultScrubber = { scrubValue: async (value) => ({ ...scrubValue(value), netconan: "off" }) };

/** The refusal when the AI sends back a secret Casper hid from it. */
export const HIDDEN_SECRET_REASON = `this change still has ${SECRET_MARKER} in it`;
export const HIDDEN_SECRET_NEXT = "Casper hid that secret from the AI, so the AI can't send it back. Type the real value yourself or leave that line out.";

/** The user can ask for a preview at most this many times for one call; then only yes or no is left. */
const MAX_PREVIEWS = 3;

/** The tool-definition half of a fingerprint ("<generation>:<hash>"). */
function toolPart(fingerprint: string): string { return fingerprint.slice(fingerprint.indexOf(":") + 1); }

/** One line for the AI when access_check says a product has no login yet; undefined when every product has one. */
function missingLoginsNote(raw: unknown): string | undefined {
  const products = parseAccessCheck(raw).products.filter((item) => item.loginMissing).map((item) => item.product).filter(isNetworkProduct);
  if (!products.length) return undefined;
  const names = products.map((product) => PRODUCT_LABELS[product]);
  if (names.length === 1) {
    return `${names[0]} has no login yet. Call one of its tools and Casper asks the person for it (or they type /mcp login ${products[0]}). Don't ask for a login in chat.`;
  }
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)} have no login yet. Call one of their tools and Casper asks the person for it (or they type /mcp login <product>). Don't ask for a login in chat.`;
}

/** The real tool name(s) an approval is for: the routed tools, or the tool itself. */
function realToolOf(plan: ApprovalPlan): string {
  return plan.routed.length ? plan.routed.map((call) => call.name).join(", ") : plan.tool;
}
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
export const MAX_SCHEMA_BYTES = 12_000;
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
  /** Servers the user answered "Yes, for this session" for, with the server's writes-off count at that moment: later
   * changes there that don't run commands, aren't destructive and that the AI didn't mark confirmed or preview-off
   * run without asking, until writes go off (ctrl+o, /mcp writes off, a disconnect) or the session ends. */
  private readonly sessionGrants = new Map<string, number>();
  /** Risky change kinds the user allowed per server this session, with the server's allowance count at that moment. */
  private readonly allowedKinds = new Map<string, { at: number; kinds: Set<ChangeKind> }>();
  private readonly confirmKind?: ConfirmKind;
  /** Servers the user answered "Yes to everything" for, with the server's allowance count then: every later call
   * there runs without a box until ctrl+o, writes off, a disconnect or the session ends. Never stored. */
  private readonly allowAll = new Map<string, number>();
  private readonly onAllowAll?: (server: string, realTool: string) => void;
  /** Told when the user's "Yes to everything" starts on a server (the footer shows it). */
  private readonly onAllowAllStart?: (server: string) => void;
  /** Per-server lines for find_capability's description (read-only logins, writes off). */
  private modelLines: string[] = [];
  /** The connected servers, by name, as of the last sync. */
  private servers = "";
  /** The direct tools picked on the first task with these servers connected. Later tasks get the same
   * ones, so the tool list, and with it the provider's prompt cache, stays put; the rest are one
   * find_capability away. Connecting or disconnecting a server, /clear or /resume picks again. */
  private picked?: { servers: string; ids: string[] };
  private readonly writesGate: boolean;
  private readonly scrubber: ResultScrubber;
  /**
   * `writesGate`: honour each server's writes switch (the app turns this on, so every server starts
   * with writes off). Brokers built directly treat writes as on. Presets, read-only logins and
   * argument guards apply either way; they only ever restrict.
   */
  /** Told when a change runs on the user's "Yes, for this session" without a box (for the transcript). */
  private readonly onSessionCovered?: (server: string, realTool: string) => void;
  private readonly onLoginMissing?: LoginMissingHandler;
  /** What each router server's find_tool said about its inner tools (kind, product), per server. Kept while the
   * server's definition stays the same, so the restart that turns writes on keeps them; a changed definition or a
   * server that is gone starts afresh. At most MAX_HITS_PER_SERVER names a server. */
  private readonly hits = new Map<string, { definition: string; tools: Map<string, RouterHit> }>();
  constructor(private readonly manager: MCPManager, private readonly confirm?: ConfirmCapability,
    options: { writesGate?: boolean; scrubber?: ResultScrubber; onSessionCovered?: (server: string, realTool: string) => void; confirmKind?: ConfirmKind;
      onAllowAll?: (server: string, realTool: string) => void; onAllowAllStart?: (server: string) => void; onLoginMissing?: LoginMissingHandler } = {}) {
    if (options.onLoginMissing) this.onLoginMissing = options.onLoginMissing;
    if (options.onAllowAll) this.onAllowAll = options.onAllowAll;
    if (options.onAllowAllStart) this.onAllowAllStart = options.onAllowAllStart;
    this.writesGate = options.writesGate ?? false;
    if (options.confirmKind) this.confirmKind = options.confirmKind;
    this.scrubber = options.scrubber ?? BUILT_IN_SCRUBBER;
    if (options.onSessionCovered) this.onSessionCovered = options.onSessionCovered;
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
    // Writes off only means "pinned, and every change asks": when the person can be asked, the box can turn writes
    // on, so the guard checks as if they were on. With nobody to ask (one-shot), writes off still refuses.
    const guard = guardArguments(policy.match, capability.tool, frozenArgs, { writes: this.confirm ? "on" : this.writes(policy), showOptIn: policy.showOptIn });
    if (typeof guard === "object") throw new NotExecutedError(guard.refuse);
    // 4. Hidden-secret marker: the AI never saw the real secret, so it can't send it back.
    if (containsHiddenSecret(frozenArgs)) throw new NotExecutedError(HIDDEN_SECRET_REASON, HIDDEN_SECRET_NEXT);
    // 5. Approval. The call is judged by the real tool behind a router, and the AI can never skip it:
    // confirm/force set to true or a preview switch set to false asks even for a read tool.
    const notes = approvalNotes(policy.match, capability.tool);
    const noPreview = hasNoPreview(policy.match, capability.tool);
    // Each routed tool carries the kind the server's find_tool gave it: it can only make the call stricter.
    // Casper's own network server (recognised by what it runs): invoke_tool running one tool Casper can see, whose kind
    // find_tool told Casper, is judged by that tool (a write, plus its name and kind), not as a destructive dispatcher,
    // so a plain change can be allowed for the session. Destructive names and risky or disruptive kinds still ask every
    // time. A tool find_tool never named stays destructive: its name alone can't tell a firmware change from a config one.
    const byRealTool = Boolean(policy.match?.preset.routedByRealTool) && policy.match?.by === "definition"
      && capability.tool.name === "invoke_tool" && capability.tool.annotations?.destructiveHint !== true;
    const hitKinds = this.hitKinds(capability.descriptor.source);
    const plan = withHitKinds(buildPlan({
      server: capability.descriptor.source, tool: capability.tool.name, label: capability.descriptor.safety,
      schema: capability.tool.inputSchema, arguments: frozenArgs,
      ...(notes.length || noPreview ? { hint: { ...(notes.length ? { executeNote: notes.join(" ") } : {}), ...(noPreview ? { noPreview } : {}) } } : {}),
    }), hitKinds);
    if (byRealTool && plan.routed.length === 1 && !plan.routerUnclear && hitKinds.has(plan.routed[0]!.name)) plan.label = "write";
    const label = planLabel(plan);
    // A router call is judged by the real tools it runs: a write behind a read router is refused
    // like the write tool itself while writes are off (or for a read-only login).
    this.refuseByPolicy(capability, label);
    // The one opt-in: the user let plain Junos show commands run without asking. Anything the AI
    // set to skip a check still asks.
    const optedIn = guard === "allow" && !plan.routed.length && !plan.routerUnclear
      && aiConfirm(plan.arguments).length === 0 && previewSwitchedOff(plan.arguments).length === 0;
    // "Yes to everything" on this server: no kind box and no change box, whatever the call (the box said so).
    const allCovered = needsApproval(plan) && !optedIn && this.allowAllOn(plan.server);
    // Risky kinds (firmware, delete, admin) are off by default: the user allows the kind first, then the change box asks.
    if (needsApproval(plan) && !optedIn && !allCovered) await this.allowRiskyKinds(capability, plan, combined);
    // Covered by the user's "Yes, for this session": approved without a box, so server questions still reach them.
    const covered = allCovered || (needsApproval(plan) && !optedIn && this.sessionCovers(plan, capability));
    const writesBefore = this.writes(policy);
    const answer = covered ? { realTool: realToolOf(plan), once: false }
      : needsApproval(plan) && !optedIn ? await this.approve(capability, plan, combined) : undefined;
    // Writes turned off (ctrl+o, /mcp writes off) while the box was open: the user's latest word is "off", so a yes
    // given in that box no longer counts and doesn't turn writes back on.
    if (answer && writesBefore === "on" && this.writes(this.manager.policy(plan.server)) === "off") {
      throw new NotExecutedError(writesOffReason(plan.server));
    }
    // A session answer is recorded only once it counts: never for a yes the refusal above set aside.
    if (answer && "session" in answer && answer.session) this.sessionGrants.set(plan.server, this.manager.writesOffCount(plan.server));
    if (answer && "all" in answer && answer.all) {
      this.allowAll.set(plan.server, this.manager.allowanceEnds(plan.server));
      this.onAllowAllStart?.(plan.server);
    }
    const approved = answer?.realTool;
    // Approved on a server whose writes are off right now (read fresh: the person may have turned them on while the
    // box was open): turn them on (it restarts without its read-only pins once its calls finish) before the change
    // runs. Only the call that turned them on, and only for "Yes, this once", turns them off again, on every way out.
    // A troubleshooting check on a server whose own gate lets its checked list through the read-only pin runs pinned:
    // the box still asked, but writes stay off, so a show command never restarts the server twice.
    const pinnedCheck = Boolean(policy.match?.preset.troubleshootRunsPinned) && label !== "destructive"
      && planKinds(plan, capability.tool).every((kind) => kind === "troubleshoot");
    const turnedOn = Boolean(answer) && label !== "read" && !pinnedCheck && this.writesGate && this.writes(this.manager.policy(plan.server)) === "off";
    let raw: unknown;
    try {
      if (turnedOn) await this.manager.setWrites(plan.server, true);
      notCancelled(combined);
      this.sync();
      const current = this.get(id);
      // Turning writes on (by this box, or by the person while it was open) restarts a pinned server: a new
      // connection. The approval still holds when the server offers exactly the same tool definition; any other
      // change asks for a new search.
      const writesChanged = turnedOn || this.writes(current.policy) !== writesBefore;
      const sameTool = writesChanged ? toolPart(current.fingerprint) === toolPart(capability.fingerprint) : current.fingerprint === capability.fingerprint;
      if (!sameTool) throw new NotExecutedError("tool changed; search again");
      if (current.hidden) throw new NotExecutedError(current.hidden);
      this.refuseByPolicy(current, label);
      if (typeof guardArguments(current.policy.match, current.tool, frozenArgs, { writes: this.writes(current.policy), showOptIn: current.policy.showOptIn }) === "object") {
        throw new NotExecutedError(writesOffReason(capability.descriptor.source));
      }
      if (allCovered) this.onAllowAll?.(plan.server, realToolOf(plan));
      else if (covered) this.onSessionCovered?.(plan.server, realToolOf(plan));
      // 6. Call, under the per-server call clock. Only an approved call may carry server questions to the user.
      raw = await this.manager.call(capability.descriptor.source, capability.tool.name, frozenArgs, combined,
        approved ? { approved: { capabilityId: id, realTool: approved, label } } : {});
    } finally {
      if (turnedOn && answer?.once) await this.manager.setWrites(plan.server, false, { once: true }).catch(() => {});
    }
    // Casper's network server (recognised by what it runs) had no login for this product: the person is asked, and
    // the AI gets one line back. Any other server's look-alike answer is an ordinary result.
    const ownNetwork = this.getsLogins(capability);
    // A saved login the product turned down (expired, revoked) asks to replace it the same way.
    const missing = this.onLoginMissing && ownNetwork ? loginMissing(raw) : undefined;
    const expired = this.onLoginMissing && ownNetwork && !missing ? loginExpired(raw, this.toolProduct(plan)) : undefined;
    const login = missing ?? expired;
    if (login) {
      const text = await this.onLoginMissing!(capability.descriptor.source, login, combined, expired ? "expired" : "missing");
      return { isError: true, executed: true, summary: text, truncated: false, originalBytes: Buffer.byteLength(text) };
    }
    // The AI asked access_check first: tell it Casper asks for a missing login, so it never asks in chat or suggests config.
    const missingNote = ownNetwork && capability.tool.name === ACCESS_TOOL ? missingLoginsNote(raw) : undefined;
    if (capability.router && capability.tool.name === "find_tool") this.rememberHits(capability.descriptor.source, raw);
    // 7. Hide device secrets (passwords, keys, SNMP communities) before anything else reads the result.
    const scrubbed = await this.scrub(raw, combined, capability.descriptor.source);
    if (planMode(plan) === "preview") this.previews.set(this.previewSlot(capability, plan), { text: previewText(scrubbed.value), at: Date.now() });
    // 8. Bound: per-list limits, the next-page cursor kept, duplicate text dropped.
    const result = boundCapabilityResult(scrubbed.value, 16_384, 50, { mcp: true });
    const note = scrubNote(scrubbed);
    if (scrubbed.hidden > 0) result.secretsHidden = scrubbed.hidden;
    if (note) result.summary = `${result.summary} ${note}`;
    if (missingNote) result.summary = `${result.summary} ${missingNote}`;
    return result;
  }

  /** The product of the one real tool a call runs: what find_tool said, else its name's prefix (mist_, central_, clearpass_). */
  private toolProduct(plan: ApprovalPlan): NetworkProduct | undefined {
    if (plan.routed.length !== 1 || plan.routerUnclear) return undefined;
    const name = plan.routed[0]!.name;
    const prefix = name.split("_")[0];
    return this.hitProduct(plan.server, name) ?? (isNetworkProduct(prefix) ? prefix : undefined);
  }

  /** Casper's own network server, by what it runs and not a project's: the one that gets the saved logins. */
  private getsLogins(capability: Capability): boolean {
    const { match } = capability.policy;
    if (!match?.preset.logins || match.by !== "definition") return false;
    try { return getsLogins(this.manager.definition(capability.descriptor.source)); } catch { return false; }
  }

  /** The call already ran, so scrubbing never fails it: any problem (or an abort during netconan)
   * falls back to Casper's own rules. */
  private async scrub(raw: unknown, signal: AbortSignal, server: string): Promise<ScrubOutcome<unknown>> {
    // First the saved logins this server was started with (a Central client ID matches no pattern), then the shared rules.
    let values: readonly string[] = [];
    try { values = this.manager.loginValues(server); } catch { /* not connected any more */ }
    const exact = values.length ? scrubValue(raw, (text) => scrubExactValues(text, values)) : { value: raw, hidden: 0, kinds: [] };
    let outcome: ScrubOutcome<unknown>;
    try { outcome = await this.scrubber.scrubValue(exact.value, signal); }
    catch { outcome = { ...scrubValue(exact.value), netconan: "failed" }; }
    if (!exact.hidden) return outcome;
    return { ...outcome, hidden: outcome.hidden + exact.hidden, kinds: [...new Set([...exact.kinds, ...outcome.kinds])] };
  }

  /**
   * Ask the user until they say yes (returns the real tool name for the approved call) or no (throws).
   * "p" runs the preview, when the tool's own schema declares one, and asks again with its result.
   */
  private async approve(capability: Capability, plan: ApprovalPlan, signal: AbortSignal): Promise<{ realTool: string; once: boolean; session?: boolean; all?: boolean }> {
    if (!this.confirm) throw new NotExecutedError("needs your approval, and this run cannot ask");
    const realTool = realToolOf(plan);
    const slot = this.previewSlot(capability, plan);
    const product = capability.policy.match?.preset.logins ? this.toolProduct(plan) : undefined;
    for (let previews = 0; ; previews++) {
      const lastPreview = this.previews.get(slot);
      // After the last allowed preview the box is shown once more, without "p", so the user sees it.
      const shown: ApprovalPlan = previews < MAX_PREVIEWS ? plan : { ...plan, hint: { ...plan.hint, noPreview: true } };
      const answer = await this.confirm({
        capability: structuredClone(capability.descriptor), arguments: structuredClone(plan.arguments),
        plan: structuredClone(shown), ...(lastPreview ? { lastPreview: { ...lastPreview } } : {}),
        ...(capability.tool._meta ? { tool: { _meta: structuredClone(capability.tool._meta) } } : {}),
        ...(product ? { product } : {}),
      }, signal);
      notCancelled(signal);
      if (answer === true || answer === "yes") return { realTool, once: true };
      if (answer === "allow-all") return { realTool, once: false, all: true };
      // "For this session" only where it is offered; anywhere else it counts as this once.
      if (answer === "yes-session") return sessionAllowed(planLabel(shown)) && !asksEveryTime(shown, capability.tool) ? { realTool, once: false, session: true } : { realTool, once: true };
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

  /**
   * Each risky kind the call makes that the user hasn't allowed on this server: ask (only with writes gated, as the
   * app runs; brokers built directly treat writes and kinds as on). No, or nobody to ask, and nothing runs.
   */
  private async allowRiskyKinds(capability: Capability, plan: ApprovalPlan, signal: AbortSignal): Promise<void> {
    if (!this.writesGate) return;
    const kinds = [...new Set(planKinds(plan, capability.tool))].filter((kind) => isRiskyKind(kind) && !this.kindAllowed(plan.server, kind));
    for (const kind of kinds) {
      const off = `${KIND_TEXT[kind]} are off by default on ${plan.server}`;
      if (!this.confirm || !this.confirmKind) throw new NotExecutedError(`${off}, and this run cannot ask`);
      // Counted before the box: if writes go off while it is open, the allowance is already over.
      const at = this.manager.allowanceEnds(plan.server);
      const yes = await this.confirmKind({ server: plan.server, kind, realTool: realToolOf(plan) }, signal);
      notCancelled(signal);
      if (!yes) throw new NotExecutedError("you said no");
      if (yes === true) this.allowKind(plan.server, kind, at);
    }
  }

  /** True when the user allowed this risky kind on this server, and nothing has ended it since. */
  kindAllowed(server: string, kind: ChangeKind): boolean {
    if (this.manager.rememberedKinds(server).includes(kind)) return true;
    return this.sessionKinds(server).includes(kind);
  }

  /** The risky kinds allowed on this server for this session only (not the remembered ones). */
  sessionKinds(server: string): ChangeKind[] {
    const given = this.allowedKinds.get(server);
    if (!given) return [];
    if (given.at !== this.manager.allowanceEnds(server)) { this.allowedKinds.delete(server); return []; }
    return [...given.kinds];
  }

  /** Allow a risky kind on a server for this session. Only the user's own answer or command calls this. */
  allowKind(server: string, kind: ChangeKind, at = this.manager.allowanceEnds(server)): void {
    const given = this.allowedKinds.get(server);
    if (given && given.at === at) given.kinds.add(kind);
    else this.allowedKinds.set(server, { at, kinds: new Set([kind]) });
  }

  /** True while the user's "Yes to everything" holds on this server. */
  allowAllOn(server: string): boolean {
    const given = this.allowAll.get(server);
    if (given === undefined) return false;
    if (given !== this.manager.allowanceEnds(server)) { this.allowAll.delete(server); return false; }
    return true;
  }

  /** /mcp allow <server>, then 6: the user's own "Yes to everything" on that server for this session. */
  startAllowAll(server: string): void {
    this.allowAll.set(server, this.manager.allowanceEnds(server));
    this.onAllowAllStart?.(server);
  }

  /** /mcp allow <server> off: end that server's session kinds and "Yes to everything" (session answers stay). */
  endAllowancesFor(server: string): void {
    this.allowedKinds.delete(server);
    this.allowAll.delete(server);
  }

  /** The servers under "Yes to everything" right now (the footer shows them). */
  allowAllServers(): string[] { return [...this.allowAll.keys()].filter((server) => this.allowAllOn(server)).sort(); }

  /** ctrl+o: end every session answer, allowed kind and "Yes to everything", on every server. True when any were in force. */
  endAllowances(): boolean {
    const any = this.sessionGrants.size > 0 || this.allowedKinds.size > 0 || this.allowAll.size > 0;
    this.sessionGrants.clear();
    this.allowedKinds.clear();
    this.allowAll.clear();
    return any;
  }

  /** True when the user said "Yes, for this session" on this server. */
  sessionGrant(server: string): boolean {
    const given = this.sessionGrants.get(server);
    if (given === undefined) return false;
    // Writes went off since (ctrl+o, /mcp writes off, a disconnect): the answer is over, even if writes are back on.
    if (given !== this.manager.writesOffCount(server)) { this.sessionGrants.delete(server); return false; }
    return true;
  }

  /** End the session answer for one server, or every server (ctrl+o, writes off, reconnect, a changed definition). */
  endSessionGrants(server?: string): void {
    if (server === undefined) this.sessionGrants.clear();
    else this.sessionGrants.delete(server);
  }

  /** A session answer covers a change that is not destructive and that the AI didn't mark confirmed or preview-off.
   * It stands only while the server's writes are on: ctrl+o, /mcp writes off or a disconnect ends it. */
  private sessionCovers(plan: ApprovalPlan, capability: Capability): boolean {
    if (!this.sessionGrant(plan.server)) return false;
    if (this.writes(capability.policy) === "off") { this.sessionGrants.delete(plan.server); return false; }
    // Risky and disruptive kinds ask every time, like destructive changes.
    if (asksEveryTime(plan, capability.tool)) return false;
    return sessionAllowed(planLabel(plan)) && !plan.routerUnclear
      && aiConfirm(plan.arguments).length === 0 && previewSwitchedOff(plan.arguments).length === 0;
  }

  private previewSlot(capability: Capability, plan: ApprovalPlan): string {
    // The whole fingerprint (connection and tool definition): a reconnect or a changed tool never
    // shows an old preview, even when the preview finished after the tool list changed.
    return `${capability.fingerprint}|${previewKey(plan)}`;
  }

  /** A new conversation (/clear, /resume): its first task picks the direct tools afresh. */
  resetPicks(): void {
    this.picked = undefined;
  }

  close(): Promise<void> {
    this.closed.abort();
    this.capabilities.clear();
    return this.manager.close();
  }

  private writes(policy: ServerPolicy): "off" | "on" { return this.writesGate ? policy.writes : "on"; }

  /** The definition a server's find_tool kinds belong to. */
  private definitionKey(server: string): string {
    try { return hash(JSON.stringify(this.manager.definition(server))); } catch { return ""; }
  }

  /** The find_tool hits kept for this server, or none when its definition changed since. */
  private hitsFor(server: string): Map<string, RouterHit> | undefined {
    const kept = this.hits.get(server);
    if (!kept) return undefined;
    if (kept.definition !== this.definitionKey(server)) { this.hits.delete(server); return undefined; }
    return kept.tools;
  }

  /** The kind the server's find_tool gave each inner tool on this server. */
  hitKinds(server: string): Map<string, ChangeKind> {
    return new Map([...this.hitsFor(server) ?? []].map(([name, hit]) => [name, hit.kind]));
  }

  /** The product the server's find_tool named for an inner tool ("mist"), when it named one Casper knows. */
  hitProduct(server: string, tool: string): RouterHit["product"] {
    return this.hitsFor(server)?.get(tool)?.product;
  }

  /** Keep a find_tool result's kinds. A name seen again keeps the riskier kind; past the limit, the oldest go. */
  private rememberHits(server: string, raw: unknown): void {
    const found = hitKindsFrom(raw);
    if (!found.size) return;
    let tools = this.hitsFor(server);
    if (!tools) { tools = new Map(); this.hits.set(server, { definition: this.definitionKey(server), tools }); }
    for (const [name, hit] of found) {
      const prev = tools.get(name);
      tools.delete(name);
      tools.set(name, prev ? { kind: riskier(prev.kind, hit.kind), ...(hit.product ?? prev.product ? { product: hit.product ?? prev.product! } : {}) } : hit);
    }
    while (tools.size > MAX_HITS_PER_SERVER) tools.delete(tools.keys().next().value!);
  }

  /** The same hiding rule as sync(), applied to the label a call is judged by (a router's real tools). */
  private refuseByPolicy(capability: Capability, label: CapabilitySafety): void {
    const { policy, tool } = capability;
    const server = capability.descriptor.source;
    const access = policy.access?.state ?? "unknown";
    if (access === "read-only" && isHidden(undefined, tool, label, { writes: "on", access })) throw new NotExecutedError(readOnlyLoginReason(server));
  }

  private sync(): void {
    const revision = this.manager.catalogRevision;
    if (revision === this.indexedRevision) return;
    const next = new Map<string, Capability>();
    const lines: string[] = [];
    const servers: string[] = [];
    if (!this.closed.signal.aborted) for (const { server, generation, tools } of this.manager.catalog()) {
      servers.push(server);
      const routed = tools.some((tool) => tool.name === "find_tool") && tools.some((tool) => tool.name === "invoke_read_tool");
      const policy = this.manager.policy(server);
      const writes = this.writes(policy);
      const access = policy.access?.state ?? "unknown";
      // Built from the server's name and Casper's parsed state only; never from server text.
      lines.push(...accessModelLines(server, policy.access, writes));
      let definition: ReturnType<MCPManager["definition"]> | undefined;
      try { definition = this.manager.definition(server); } catch { definition = undefined; }
      const docsServer = docsPinned(definition, policy.match, tools);
      for (const tool of tools) {
        const id = `mcp:${encodeURIComponent(server)}:${encodeURIComponent(tool.name)}`;
        // A preset can only make the label stricter.
        const safety = tightenSafety(policy.match, tool, toolLabel(tool));
        const descriptor: CapabilityDescriptor = {
          id, source: server, name: tool.name, description: (tool.description ?? "").slice(0, 1024),
          tags: [], safety, schemaRef: id,
        };
        // Only a read-only login hides changes. Writes off means the server runs pinned and every change asks.
        const hidden = access === "read-only" && isHidden(policy.match, tool, safety, { writes: "on", access })
          ? readOnlyLoginReason(server) : undefined;
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
          ...(docsServer && !hidden && safety === "read" && (DOCS_TOOL_NAMES as readonly string[]).includes(tool.name) ? { docs: true as const } : {}),
        });
      }
    }
    this.capabilities = next;
    this.modelLines = lines.sort(order);
    this.servers = JSON.stringify(servers.sort(order));
    this.indexedRevision = revision;
    // A reconnect or a changed tool list makes old previews stale.
    this.previews.clear();
    // A session answer ends with the server's connection.
    const connected = new Set([...next.values()].map((capability) => capability.descriptor.source));
    for (const server of [...this.sessionGrants.keys()]) if (!connected.has(server)) this.sessionGrants.delete(server);
    for (const server of [...this.allowedKinds.keys()]) if (!connected.has(server)) this.allowedKinds.delete(server);
    for (const server of [...this.allowAll.keys()]) if (!connected.has(server)) this.allowAll.delete(server);
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
    // Docs tools of a recognised hpe-networking-mcp server come right after the routers, whatever the task words.
    const docs = [...this.capabilities.values()].filter((c) => c.docs && !c.hidden).sort((a, b) =>
      DOCS_TOOL_NAMES.indexOf(a.descriptor.name as typeof DOCS_TOOL_NAMES[number]) - DOCS_TOOL_NAMES.indexOf(b.descriptor.name as typeof DOCS_TOOL_NAMES[number])
      || a.descriptor.id.localeCompare(b.descriptor.id)).slice(0, 3);
    const pinned = new Set([...routers, ...docs]);
    // Same servers as when the set was picked: offer it again (less any tool that went away or is now hidden).
    const kept = this.picked?.servers === this.servers ? this.picked.ids : undefined;
    const candidates = kept
      ? kept.map((id) => this.capabilities.get(id)).filter((c): c is Capability => c !== undefined && !c.hidden)
      : [...routers, ...docs, ...this.rank(task).filter((c) => !routedServers.has(c.descriptor.source) && !pinned.has(c))];
    const ids: string[] = [];
    let schemaBytes = 0;
    for (const capability of candidates) {
      if (tools.length >= 8) break;
      const bytes = capability.schemaBytes;
      if (bytes > MAX_SCHEMA_BYTES || schemaBytes + bytes > MAX_DIRECT_SCHEMA_BYTES) continue;
      schemaBytes += bytes;
      ids.push(capability.descriptor.id);
      const lead = capability.docs ? `[docs; ${capability.descriptor.safety}; ${capability.descriptor.id}] ${DOCS_TOOL_NOTE} `
        : `[${capability.descriptor.safety}; ${capability.descriptor.id}] `;
      tools.push(wrap(capability.runtimeName,
        `${lead}${capability.descriptor.description}\nBounded result; non-read calls require confirmation.`,
        structuredClone(capability.tool.inputSchema), async (args, signal) => {
          const result = await this.invoke(capability.descriptor.id, args, signal);
          return { text: JSON.stringify(result), isError: result.isError };
        // Routers and non-read tools may ask; a read tool asks only when the AI set confirm itself (the app queues those).
        }, capability.descriptor.safety !== "read" || capability.router));
    }
    if (!kept) this.picked = { servers: this.servers, ids };
    return tools;
  }
}
