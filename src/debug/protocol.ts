import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { MessageReader } from "../protocol/framing";
import { isolatedEnvironment } from "../platform/environment";
import { hostProcessPlatform, OwnedProcesses, osSupportsProcessGroups } from "../platform/processes";
import { record, type DebugTarget } from "./config";

interface Pending { command: string; resolve(body: unknown): void; reject(error: Error): void; cleanup(): void }

/** DAP semantics are separate from JSON-RPC. No public arbitrary-request interface. */
export class DAPConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private readonly processes?: OwnedProcesses;
  private sequence = 0;
  private ended = false;
  private bytes = 0;
  private messages = 0;
  private initialized = false;
  private readonly waiters = new Set<() => void>();
  private closeWork?: Promise<"stopped" | "unknown">;
  private readonly exited: Promise<void>;
  onEvent?: (event: string, body: Record<string, unknown>) => void;
  onClose?: () => void;

  constructor(target: DebugTarget, home: string) {
    this.child = spawn(target.command, target.args, { cwd: target.cwd, stdio: "pipe", detached: osSupportsProcessGroups,
      env: isolatedEnvironment(home, { PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1", BUN_INSTALL_AUTO: "disable", npm_config_offline: "true" }) });
    if (this.child.pid) this.processes = new OwnedProcesses(this.child.pid, () => this.child.exitCode === null && this.child.signalCode === null, hostProcessPlatform());
    this.exited = new Promise(resolve => {
      this.child.once("close", () => { this.fail("Debugger adapter exited"); resolve(); });
      this.child.once("error", () => { this.fail("Debugger adapter could not start"); resolve(); });
    });
    this.child.stdin.on("error", () => this.fail("Debugger input closed"));
    this.child.stderr.resume();
    const reader = new MessageReader(value => this.receive(value), 1024 * 1024);
    this.child.stdout.on("data", (chunk: Buffer) => {
      if (this.ended) return;
      this.bytes += chunk.length;
      try {
        if (this.bytes > 16 * 1024 * 1024) throw new Error("budget");
        reader.push(chunk);
      } catch { this.fail("Invalid or over-budget debugger output"); }
    });
    void this.processes?.capture();
  }
  get pid(): number | undefined { return this.child.pid; }
  get alive(): boolean { return !this.ended; }
  async captureProcesses(): Promise<void> { await this.processes?.capture(); }

  private send(message: Record<string, unknown>): void {
    if (this.ended) throw new Error("Debugger connection closed");
    const json = JSON.stringify({ seq: ++this.sequence, ...message });
    if (Buffer.byteLength(json) > 65_536 || this.child.stdin.writableLength > 65_536) throw new Error("Debugger write budget exceeded");
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
  }
  request(command: string, args: Record<string, unknown> = {}, signal?: AbortSignal, timeoutMs = 5000): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new Error("Debugger request cancelled"));
    if (this.ended || (this.closeWork && command !== "disconnect")) return Promise.reject(new Error("Debugger connection closed"));
    if (this.pending.size >= 8) return Promise.reject(new Error("Debugger pending request budget exceeded"));
    const id = this.sequence + 1;
    const result = new Promise<unknown>((resolve, reject) => {
      const cancel = () => {
        this.pending.delete(id); cleanup();
        reject(new Error(signal?.aborted ? "Debugger request cancelled" : "Debugger request timed out"));
      };
      const timer = setTimeout(cancel, timeoutMs);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); };
      this.pending.set(id, { command, resolve, reject, cleanup });
      signal?.addEventListener("abort", cancel, { once: true });
      try { this.send({ type: "request", command, arguments: args }); }
      catch { this.pending.delete(id); cleanup(); reject(new Error("Debugger request could not be sent")); }
    });
    // Launch can reject while the configuration handshake is still awaiting initialized.
    void result.catch(() => {});
    return result;
  }
  waitInitialized(signal: AbortSignal): Promise<void> {
    if (this.initialized) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const check = () => {
        if (!this.initialized && !this.ended && !signal.aborted) return;
        cleanup();
        if (this.initialized && !this.ended && !signal.aborted) resolve(); else reject(new Error("Debugger initialization ended"));
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error("Debugger initialized event timed out")); }, 5000);
      const cleanup = () => { clearTimeout(timer); this.waiters.delete(check); signal.removeEventListener("abort", check); };
      this.waiters.add(check); signal.addEventListener("abort", check, { once: true }); check();
    });
  }
  private receive(value: unknown): void {
    if (this.ended) return;
    if (++this.messages > 4096 || !record(value) || !Number.isInteger(value.seq) || Number(value.seq) < 0) throw new Error("Invalid DAP message");
    if (value.type === "response") {
      if (!Number.isInteger(value.request_seq)) throw new Error("Invalid DAP response");
      const item = this.pending.get(Number(value.request_seq));
      if (!item) return; // Late or duplicate response cannot publish state.
      this.pending.delete(Number(value.request_seq)); item.cleanup();
      if (value.command !== item.command || value.success !== true) item.reject(new Error("Debugger request refused or invalid response"));
      else item.resolve(value.body ?? {});
    } else if (value.type === "event" && typeof value.event === "string") {
      if (value.event === "initialized") { this.initialized = true; for (const notify of this.waiters) notify(); }
      if (value.event === "process") void this.processes?.capture();
      this.onEvent?.(value.event, record(value.body) ? value.body : {});
    } else if (value.type === "request" && typeof value.command === "string" && value.command.length <= 128) {
      this.send({ type: "response", request_seq: value.seq, command: value.command, success: false, message: "Reverse requests are disabled" });
    } else throw new Error("Invalid DAP message type");
  }
  private fail(message: string): void {
    if (this.ended) return;
    this.ended = true;
    for (const item of this.pending.values()) { item.cleanup(); item.reject(new Error(message)); }
    this.pending.clear(); for (const notify of this.waiters) notify();
    this.onClose?.();
    void this.close();
  }
  close(): Promise<"stopped" | "unknown"> {
    if (this.closeWork) return this.closeWork;
    return this.closeWork = (async () => {
      // A coalesced pre-launch snapshot is insufficient: refresh before disconnect
      // can orphan a separately grouped debuggee.
      await this.processes?.captureCurrent();
      if (!this.ended) await this.request("disconnect", { terminateDebuggee: true }, undefined, 200).catch(() => {});
      this.fail("Debugger connection closed");
      const outcome = await this.processes?.stop() ?? "unknown";
      this.child.stdin.destroy(); this.child.stdout.destroy(); this.child.stderr.destroy();
      await Promise.race([this.exited, new Promise(resolve => setTimeout(resolve, 100))]);
      return outcome;
    })();
  }
}
