import { createHash } from "node:crypto";
import type { Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";

/**
 * One live Claude Code session per conversation (decision 54). Claude Code keeps the turns natively, the model's
 * thinking included, so a small model goes on with its plan instead of rebuilding it from a replayed transcript every
 * turn. Casper still runs every tool: Claude Code's call of a Casper tool reaches the proposal server, which answers
 * with the result Casper's own tool gave, once Pi sends it in the next request. A request that doesn't go on from
 * where the session is (compaction, a fork, a resume, an edited history, other tools) starts a new session that
 * replays the transcript, as every request did before.
 */

export type QueryHandle = Pick<Query, "accountInfo" | "close" | typeof Symbol.asyncIterator>;

/** A queue read by one consumer: Claude Code's events, or the user messages Casper sends it. */
export class Queue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly waiting: Array<(next: IteratorResult<T>) => void> = [];
  ended = false;
  push(item: T): void {
    if (this.ended) return;
    const wake = this.waiting.shift();
    if (wake) wake({ value: item, done: false }); else this.items.push(item);
  }
  end(): void {
    this.ended = true;
    for (const wake of this.waiting.splice(0)) wake({ value: undefined, done: true });
  }
  next(): Promise<IteratorResult<T>> {
    if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise(resolve => this.waiting.push(resolve));
  }
  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) { const next = await this.next(); if (next.done) return; yield next.value; }
  }
}

/** A tool call the model proposed in the session's last turn, waiting for Casper's result. */
interface Proposal { id: string; name: string; args: unknown; bound: boolean; result?: CallToolResult; answer?: (result: CallToolResult) => void }

const NO_CALL: CallToolResult = { isError: true, content: [{ type: "text", text: "Casper has no call of this tool waiting for a result." }] };
const CLOSED: CallToolResult = { isError: true, content: [{ type: "text", text: "The Claude Code session closed." }] };
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const digest = (value: unknown) => createHash("sha1").update(JSON.stringify(value) ?? "").digest("hex").slice(0, 16);

/** What identifies a message across requests: Pi hands back the same messages, and its own assistant message by id. */
export function messageKey(message: Message): string {
  if (message.role === "assistant") return `assistant:${message.responseId ?? message.timestamp}`;
  if (message.role === "toolResult") return `toolResult:${message.toolCallId}:${digest(message.content)}`;
  return `${message.role}:${message.timestamp}:${digest(message)}`;
}

/** A tool result as the proposal server returns it to Claude Code. */
export function toolResultForClaude(result: ToolResultMessage): CallToolResult {
  return { isError: result.isError, content: result.content.map(block => block.type === "text" ? { type: "text" as const, text: block.text }
    : { type: "image" as const, data: block.data, mimeType: block.mimeType }) };
}

/** Every session not yet closed, in any registry: closed if Casper exits without closing them (one listener in all). */
const open = new Set<ClaudeSession>();
let exitHook = false;

export class ClaudeSession {
  readonly input = new Queue<SDKUserMessage>();
  readonly events = new Queue<SDKMessage>();
  query?: QueryHandle;
  error?: unknown;
  closed = false;
  busy = false;
  /** The keys of the messages this session has, in order: what a request must start with to go on here. */
  known: string[] = [];
  lastUsed = Date.now();
  /** Called when Claude Code's process ends on its own (an error, a crash): the session is gone. */
  onEnded?: () => void;
  private proposals: Proposal[] = [];
  /** Calls Claude Code made before Casper had read the turn that proposed them (it calls them as soon as the turn ends). */
  private early: Array<{ id?: string; name: string; args: unknown; resolve: (result: CallToolResult) => void }> = [];
  private idle?: ReturnType<typeof setTimeout>;

  /** `keep`: a session with tools, kept for the next request; a tool-less side request's session closes after it. */
  constructor(readonly signature: string, readonly keep: boolean) {}

  /** Reads Claude Code's events into `events` from now until it ends. */
  start(query: QueryHandle): void {
    this.query = query;
    open.add(this);
    if (!exitHook) { exitHook = true; process.once("exit", () => { for (const session of [...open]) session.close(); }); }
    void (async () => {
      try { for await (const event of query) this.events.push(event); }
      catch (error) { this.error = error; }
      finally { this.events.end(); open.delete(this); this.onEnded?.(); }
    })();
  }

  get alive(): boolean { return !this.closed && !this.events.ended; }
  get waitingForResults(): string[] { return this.proposals.filter(proposal => !proposal.result).map(proposal => proposal.id); }

  /** The calls the model's turn just proposed (none for an answer): Claude Code calls each through the proposal server next. */
  proposed(calls: Array<{ id: string; name: string; arguments: unknown }>): void {
    this.proposals = calls.map(call => ({ id: call.id, name: call.name, args: call.arguments, bound: false }));
    for (const call of this.early.splice(0)) {
      const proposal = this.match(call.id, call.name, call.args);
      if (proposal) void this.bind(proposal).then(call.resolve); else call.resolve(NO_CALL);
    }
  }

  /** Claude Code's call of a Casper tool, answered with Casper's result for its proposal when Pi sends it. Claude Code
   * names the proposal (`toolUseId`); without that, the open proposal of that name, with the same arguments first. A
   * call whose proposal Casper hasn't read yet (the turn is still on its way) waits for it, never for another's. */
  answer(name: string, args: unknown, id?: string): Promise<CallToolResult> {
    if (this.closed) return Promise.resolve(CLOSED);
    const proposal = this.match(id, name, args);
    if (!proposal) return new Promise(resolve => this.early.push({ id, name, args, resolve }));
    return this.bind(proposal);
  }

  private match(id: string | undefined, name: string, args: unknown): Proposal | undefined {
    const open = this.proposals.filter(proposal => !proposal.bound);
    if (id) return open.find(proposal => proposal.id === id);
    return open.find(entry => entry.name === name && sameJson(entry.args, args)) ?? open.find(entry => entry.name === name);
  }

  private bind(proposal: Proposal): Promise<CallToolResult> {
    proposal.bound = true;
    if (proposal.result) return Promise.resolve(proposal.result);
    return new Promise(resolve => { proposal.answer = resolve; });
  }

  /** Casper's results for the proposed calls: each goes to Claude Code's waiting call, or waits for it. */
  deliver(results: readonly ToolResultMessage[]): void {
    for (const result of results) {
      const proposal = this.proposals.find(entry => entry.id === result.toolCallId);
      if (!proposal) continue;
      proposal.result = toolResultForClaude(result);
      proposal.answer?.(proposal.result);
    }
  }


  /** Waits `ms` unused, then closes (unref'd: it never keeps Casper running). */
  idleAfter(ms: number, onClose: () => void): void {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => { this.close(); onClose(); }, ms);
    this.idle.unref?.();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    open.delete(this);
    clearTimeout(this.idle);
    for (const proposal of this.proposals) proposal.answer?.(CLOSED);
    for (const call of this.early.splice(0)) call.resolve(CLOSED);
    this.proposals = [];
    this.input.end();
    try { this.query?.close(); } catch { /* already closed */ }
    this.events.end();
  }
}

/** The live sessions of one runtime's claude-subscription provider: kept for the next request, closed with the runtime. */
export class ClaudeSessions {
  readonly sessions: ClaudeSession[] = [];
  /** `max`: sessions kept at once (0: none, each request's session ends with it). */
  constructor(readonly max = 4, readonly idleMs = 15 * 60_000) {}

  /** The session `messages` goes on from: same settings, its messages first, then either the results of exactly the
   * calls it proposed or one new user message. A session the request diverged from is closed. */
  find(signature: string, keys: readonly string[], messages: readonly Message[]): { session: ClaudeSession; tail: Message[] } | undefined {
    for (const session of [...this.sessions]) {
      if (!session.alive) { this.drop(session); continue; }
      if (session.busy || session.signature !== signature || session.known.length > keys.length) continue;
      if (!session.known.every((key, index) => key === keys[index])) continue;
      const tail = messages.slice(session.known.length);
      const waiting = session.waitingForResults;
      const results = tail.length > 0 && tail.every(message => message.role === "toolResult")
        && waiting.length === tail.length && waiting.every(id => tail.some(message => message.role === "toolResult" && message.toolCallId === id));
      const followUp = waiting.length === 0 && tail.length === 1 && tail[0]!.role === "user";
      if (results || followUp) return { session, tail };
      // This conversation went another way (a steer after tool results, a retry): its next request starts afresh.
      this.drop(session);
    }
    return undefined;
  }

  add(session: ClaudeSession): void {
    this.sessions.push(session);
    session.onEnded = () => { if (!session.busy) this.drop(session); };
    // The least recently used idle sessions go first.
    const idle = this.sessions.filter(entry => !entry.busy).sort((a, b) => a.lastUsed - b.lastUsed);
    while (this.sessions.length > this.max && idle.length) this.drop(idle.shift()!);
  }

  /** After a turn: kept for the next request, or closed (a side request, a failed turn). */
  settle(session: ClaudeSession, ok: boolean): void {
    session.busy = false;
    session.lastUsed = Date.now();
    if (!ok || !session.keep || !session.alive || this.max === 0) { this.drop(session); return; }
    session.idleAfter(this.idleMs, () => this.drop(session));
  }

  drop(session: ClaudeSession): void {
    session.close();
    const at = this.sessions.indexOf(session);
    if (at >= 0) this.sessions.splice(at, 1);
  }

  closeAll(): void { for (const session of [...this.sessions]) this.drop(session); }
}
