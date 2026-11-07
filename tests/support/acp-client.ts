import { cli, type fixture } from "./scripting";

/**
 * A small ACP client written from the spec (agentclientprotocol.com), not from Casper's own code: newline-delimited
 * JSON-RPC 2.0 on the agent's stdin and stdout. It drives a real `casper acp` child against the scripted provider.
 */
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Json = Record<string, any>;
/** How the client answers one session/request_permission: an optionId, the "cancelled" outcome, a JSON-RPC error,
 * or never. */
export type PermissionAnswer = { optionId: string } | "cancelled" | "error" | "never";
/** How the client answers one elicitation/create: its result (`{action: "accept", content}`), a JSON-RPC error, or never. */
export type FormAnswer = Json | "error" | "never";

export interface AcpClient {
  request(method: string, params: Json): Promise<Json>;
  /** Several requests in one write, so the agent reads them together: each comes while the one before is handled. */
  requestTogether(calls: Array<[method: string, params: Json]>): Array<Promise<Json>>;
  notify(method: string, params: Json): void;
  /** Every session/update notification's params, in order. */
  readonly updates: Json[];
  /** Every session/request_permission the agent sent, in order. */
  readonly permissions: Json[];
  /** Every line the agent wrote to stdout, as written. */
  readonly lines: string[];
  stderr(): string;
  answerPermissions(answer: (params: Json) => PermissionAnswer | Promise<PermissionAnswer>): void;
  /** Every elicitation/create (a form) the agent sent, in order. */
  readonly forms: Json[];
  /** Default: each form is declined. */
  answerForms(answer: (params: Json) => FormAnswer | Promise<FormAnswer>): void;
  /** Ends stdin and waits for the agent to exit (killed after `ms`). */
  close(ms?: number): Promise<number>;
}

export function startAcp(f: Fixture, args: string[] = [], extraEnv: Record<string, string> = {}): AcpClient {
  const child = Bun.spawn([process.execPath, cli, "acp", ...args], { cwd: f.project, env: { ...f.env, ...extraEnv }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const pending = new Map<number, { resolve: (value: Json) => void; reject: (error: Error) => void }>();
  const updates: Json[] = [];
  const permissions: Json[] = [];
  const forms: Json[] = [];
  const lines: string[] = [];
  let errText = "";
  let nextId = 1;
  let answer: (params: Json) => PermissionAnswer | Promise<PermissionAnswer> = () => "cancelled";
  let formAnswer: (params: Json) => FormAnswer | Promise<FormAnswer> = () => ({ action: "decline" });
  const write = (message: Json) => { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`); child.stdin.flush(); };

  const handle = async (message: Json) => {
    if (message.id !== undefined && message.method === undefined) {
      const waiting = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiting?.reject(Object.assign(new Error(message.error.message), { code: message.error.code, data: message.error.data }));
      else waiting?.resolve(message.result);
      return;
    }
    if (message.method === "session/update") { updates.push(message.params); return; }
    if (message.method === "session/request_permission") {
      permissions.push(message.params);
      const given = await answer(message.params);
      if (given === "never") return;
      if (given === "error") write({ id: message.id, error: { code: -32603, message: "the client could not ask" } });
      else if (given === "cancelled") write({ id: message.id, result: { outcome: { outcome: "cancelled" } } });
      else write({ id: message.id, result: { outcome: { outcome: "selected", optionId: given.optionId } } });
      return;
    }
    if (message.method === "elicitation/create") {
      forms.push(message.params);
      const given = await formAnswer(message.params);
      if (given === "never") return;
      if (given === "error") write({ id: message.id, error: { code: -32603, message: "the client could not show the form" } });
      else write({ id: message.id, result: given });
      return;
    }
    if (message.id !== undefined) write({ id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
  };

  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        lines.push(line);
        let message: Json;
        try { message = JSON.parse(line); } catch { continue; }
        void handle(message);
      }
    }
    for (const waiting of pending.values()) waiting.reject(new Error(`casper acp ended before answering. stderr:\n${errText}`));
    pending.clear();
  })();
  void (async () => { const decoder = new TextDecoder(); for await (const chunk of child.stderr) errText += decoder.decode(chunk, { stream: true }); })();

  return {
    request(method, params) {
      const id = nextId++;
      const reply = new Promise<Json>((resolve, reject) => pending.set(id, { resolve, reject }));
      write({ id, method, params });
      return reply;
    },
    requestTogether(calls) {
      const replies = calls.map(([method, params]) => {
        const id = nextId++;
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        return new Promise<Json>((resolve, reject) => pending.set(id, { resolve, reject }));
      });
      child.stdin.flush();
      return replies;
    },
    notify(method, params) { write({ method, params }); },
    updates, permissions, forms, lines,
    stderr: () => errText,
    answerPermissions(given) { answer = given; },
    answerForms(given) { formAnswer = given; },
    async close(ms = 20_000) {
      try { child.stdin.end(); } catch { /* already closed */ }
      const timer = setTimeout(() => child.kill("SIGKILL"), ms);
      try { return await child.exited; } finally { clearTimeout(timer); }
    },
  };
}

/** Polls until `check` returns something truthy (a screen/process test never reads once after an action). */
export async function until<T>(check: () => T | undefined | false, ms = 30_000, what = "the condition"): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

/** The text of every agent_message_chunk of one session, joined. */
export const agentText = (updates: Json[], sessionId: string) => updates.filter((update) => update.sessionId === sessionId && update.update.sessionUpdate === "agent_message_chunk")
  .map((update) => update.update.content.text as string).join("");
