// JSON-RPC 2.0 as ACP carries it: one JSON message per line on stdin and stdout (agentclientprotocol.com,
// "Transports"). Both ends may send requests; this is the small part of it that `casper acp` needs.

export type Json = Record<string, unknown>;
export interface RpcError { code: number; message: string; data?: unknown }
export interface RpcMessage { jsonrpc?: "2.0"; id?: number | string | null; method?: string; params?: unknown; result?: unknown; error?: RpcError }

/** The JSON-RPC and ACP error codes `casper acp` answers with. `authRequired` is ACP's own: a sign-in is needed, or the
 * one asked for did not happen. */
export const RPC = { parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internal: -32603, notFound: -32002, authRequired: -32000 } as const;

/** An error that goes back to the client as a JSON-RPC error, with its code. */
export class RpcFailure extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}

export type RequestHandler = (params: Json) => Promise<unknown>;
export type NotificationHandler = (params: Json) => void;
/** Runs right after a request's reply line is written (never after an error reply): what must follow the reply. */
export type AfterReply = (result: unknown, params: Json) => void;

/**
 * One peer: reads lines from `input`, writes lines with `write`. Requests from the other side go to the handler named
 * by their method (an unknown one is "Method not found"); requests we send resolve with the reply's result, or reject
 * with its error. A line that is not JSON is answered with a parse error, as JSON-RPC asks.
 */
export class RpcConnection {
  private nextId = 1;
  private readonly waiting = new Map<number | string, { resolve: (value: unknown) => void; reject: (error: RpcFailure) => void }>();
  private readonly requests = new Map<string, { handler: RequestHandler; after?: AfterReply }>();
  private readonly notifications = new Map<string, NotificationHandler>();
  private ended = false;
  /** Resolves when the input ends; every request still waiting rejects then. */
  readonly closed: Promise<void>;

  constructor(input: AsyncIterable<Uint8Array | string>, private readonly write: (line: string) => void) {
    this.closed = this.read(input);
  }

  /** `after`: runs once the reply line is written (session/new's commands come after the reply that names the session). */
  onRequest(method: string, handler: RequestHandler, after?: AfterReply): void { this.requests.set(method, { handler, ...(after ? { after } : {}) }); }
  onNotification(method: string, handler: NotificationHandler): void { this.notifications.set(method, handler); }

  /** Sends a request and waits for its reply. Rejects when the reply is an error, or when the input ends first. */
  request(method: string, params: Json, signal?: AbortSignal): Promise<unknown> {
    if (this.ended) return Promise.reject(new RpcFailure(RPC.internal, "the connection is closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const stop = () => { this.waiting.delete(id); reject(new RpcFailure(RPC.internal, "cancelled")); };
      if (signal?.aborted) { stop(); return; }
      signal?.addEventListener("abort", stop, { once: true });
      this.waiting.set(id, { resolve: (value) => { signal?.removeEventListener("abort", stop); resolve(value); },
        reject: (error) => { signal?.removeEventListener("abort", stop); reject(error); } });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: Json): void { this.send({ method, params }); }

  /** Writes one message as it is (a router passes another peer's message on). */
  send(message: RpcMessage): void {
    if (this.ended) return;
    this.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }

  private async read(input: AsyncIterable<Uint8Array | string>): Promise<void> {
    const decoder = new TextDecoder();
    // The line so far, from chunks with no line end in them. Only a new chunk is searched for one, and the parts are
    // joined once it comes, so a long line (a prompt with pictures in it) costs its length, not its length squared.
    let partial: string[] = [];
    try {
      for await (const chunk of input) {
        const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
        let start = 0;
        for (let end = text.indexOf("\n"); end >= 0; end = text.indexOf("\n", start)) {
          const line = (partial.length ? partial.join("") + text.slice(start, end) : text.slice(start, end)).trim();
          partial = [];
          start = end + 1;
          if (line) this.receive(line);
        }
        if (start < text.length) partial.push(text.slice(start));
      }
      const rest = partial.join("").trim();
      if (rest) this.receive(rest);
    } catch { /* the input failed: the same as its end */ }
    this.ended = true;
    for (const waiting of this.waiting.values()) waiting.reject(new RpcFailure(RPC.internal, "the connection closed"));
    this.waiting.clear();
  }

  private receive(line: string): void {
    let message: RpcMessage;
    try { message = JSON.parse(line) as RpcMessage; } catch { this.send({ id: null, error: { code: RPC.parse, message: "Parse error" } }); return; }
    if (!message || typeof message !== "object") { this.send({ id: null, error: { code: RPC.invalidRequest, message: "Invalid Request" } }); return; }
    if (message.method === undefined) {
      if (message.id === undefined || message.id === null) return;
      const waiting = this.waiting.get(message.id);
      this.waiting.delete(message.id);
      if (message.error) waiting?.reject(new RpcFailure(message.error.code, message.error.message));
      else waiting?.resolve(message.result);
      return;
    }
    const params = (message.params && typeof message.params === "object" ? message.params : {}) as Json;
    if (message.id === undefined || message.id === null) {
      const handler = this.notifications.get(message.method);
      if (handler) { try { handler(params); } catch { /* a notification has no reply */ } }
      return;
    }
    const id = message.id;
    const entry = this.requests.get(message.method);
    if (!entry) { this.send({ id, error: { code: RPC.methodNotFound, message: `Method not found: ${message.method}` } }); return; }
    entry.handler(params).then((result) => {
      this.send({ id, result: result ?? null });
      try { entry.after?.(result, params); } catch { /* the reply is out; nothing to answer */ }
    }, (error: unknown) => {
      const failure = error instanceof RpcFailure ? error : new RpcFailure(RPC.internal, error instanceof Error ? error.message : String(error));
      this.send({ id, error: { code: failure.code, message: failure.message } });
    });
  }
}
