import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Bounded Content-Length framing, independent of the runtime and language. */
export class MessageReader {
  private readonly header = Buffer.alloc(8196);
  private headerBytes = 0;
  private body?: Buffer;
  private bodyBytes = 0;
  constructor(private readonly receive: (message: unknown) => void, private readonly maxBytes = 4 * 1024 * 1024) {}
  push(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.body) {
        if (this.headerBytes === this.header.length) throw new Error("LSP header too large");
        this.header[this.headerBytes++] = chunk[offset++];
        const end = this.headerBytes - 4;
        if (end < 0 || this.header.readUInt32BE(end) !== 0x0d0a0d0a) continue;
        const lengths = this.header.subarray(0, end).toString("ascii").split("\r\n").filter((line) => /^content-length:/i.test(line));
        if (lengths.length !== 1 || !/^content-length: *\d+ *$/i.test(lengths[0])) throw new Error("Invalid LSP frame");
        const size = Number(lengths[0].split(":")[1]);
        if (!Number.isSafeInteger(size) || size <= 0 || size > this.maxBytes) throw new Error("LSP frame too large");
        // Copy each body byte only once, regardless of transport fragmentation.
        this.body = Buffer.alloc(size);
        this.bodyBytes = 0;
        this.headerBytes = 0;
      }
      const length = Math.min(this.body.length - this.bodyBytes, chunk.length - offset);
      chunk.copy(this.body, this.bodyBytes, offset, offset + length);
      this.bodyBytes += length;
      offset += length;
      if (this.bodyBytes === this.body.length) {
        const body = this.body;
        this.body = undefined;
        this.receive(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)));
      }
    }
  }
}

type Pending = { resolve(value: unknown): void; reject(error: Error): void; cleanup(): void };

export class LSPConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private ended = false;
  private closing?: Promise<void>;
  private readonly exited: Promise<void>;
  onNotification?: (method: string, params: unknown) => void;
  onClose?: () => void;

  constructor(command: string, args: string[], cwd: string, private readonly timeoutMs = 10_000) {
    this.child = spawn(command, args, { cwd, stdio: "pipe", shell: false, detached: process.platform !== "win32" });
    this.exited = new Promise((resolve) => {
      this.child.once("close", () => { this.fail("LSP server exited"); resolve(); });
      this.child.once("error", () => { this.fail("LSP server could not start"); resolve(); });
    });
    this.child.stdin.on("error", () => this.fail("LSP input closed"));
    this.child.stderr.resume(); // Never echo server logs (may contain source or secrets).
    const reader = new MessageReader((message) => this.receive(message));
    this.child.stdout.on("data", (chunk: Buffer) => {
      try { reader.push(chunk); } catch { this.fail("Invalid LSP output"); }
    });
  }

  get alive(): boolean { return !this.ended; }

  private send(message: unknown): void {
    if (this.ended) throw new Error("LSP connection closed");
    const json = JSON.stringify(message);
    if (Buffer.byteLength(json) > 4 * 1024 * 1024 || this.child.stdin.writableLength > 4 * 1024 * 1024) {
      throw new Error("LSP output budget exceeded");
    }
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
  }

  notify(method: string, params?: unknown): void { this.send({ jsonrpc: "2.0", method, params }); }

  request(method: string, params?: unknown, signal?: AbortSignal, timeoutMs = this.timeoutMs): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new Error("LSP request cancelled"));
    if (this.ended || this.closing) return Promise.reject(new Error("LSP connection closed"));
    if (this.pending.size >= 64) return Promise.reject(new Error("Too many LSP requests"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const cancel = () => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        entry.cleanup();
        try { this.notify("$/cancelRequest", { id }); } catch { /* already closed */ }
        reject(new Error(signal?.aborted ? "LSP request cancelled" : "LSP request timed out"));
      };
      const timer = setTimeout(cancel, timeoutMs);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); };
      this.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener("abort", cancel, { once: true });
      try { this.send({ jsonrpc: "2.0", id, method, params }); }
      catch (error) { this.pending.delete(id); cleanup(); reject(error); }
    });
  }

  private receive(value: unknown): void {
    if (!record(value) || value.jsonrpc !== "2.0") throw new Error("Invalid JSON-RPC");
    if (typeof value.method === "string") {
      if ("id" in value) {
        // No server-initiated writes, command execution, or dynamic registration.
        if (value.method === "workspace/applyEdit") {
          this.send({ jsonrpc: "2.0", id: value.id, result: { applied: false, failureReason: "Server-initiated writes are disabled" } });
        } else {
          this.send({ jsonrpc: "2.0", id: value.id, error: { code: -32601, message: "Unsupported client request" } });
        }
      } else this.onNotification?.(value.method, value.params);
      return;
    }
    if (typeof value.id !== "number") return;
    const pending = this.pending.get(value.id);
    if (!pending) return; // cancelled/late response
    this.pending.delete(value.id);
    pending.cleanup();
    if ("error" in value) pending.reject(new Error(`LSP request failed (${record(value.error) && typeof value.error.code === "number" ? value.error.code : "unknown"})`));
    else if ("result" in value) pending.resolve(value.result);
    else pending.reject(new Error("Invalid LSP response"));
  }

  private fail(message: string): void {
    if (this.ended) return;
    this.ended = true;
    this.onClose?.();
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(new Error(message)); }
    this.pending.clear();
    try {
      if (process.platform !== "win32" && this.child.pid) process.kill(-this.child.pid, "SIGKILL");
      else this.child.kill("SIGKILL");
    } catch { /* process group already exited */ }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    // Start shutdown before setting closing (which prevents other requests).
    const shutdown = this.ended ? Promise.resolve() : this.request("shutdown", null, undefined, 150).catch(() => {});
    this.closing = (async () => {
      await shutdown;
      try { this.notify("exit"); } catch { /* already closed */ }
      this.fail("LSP connection closed");
      await this.exited;
    })();
    return this.closing;
  }
}
