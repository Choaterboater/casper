import net from "node:net";

export type Status = "open" | "closed" | "timeout";

export interface ProbeResult {
  readonly status: Status;
  readonly ms: number;
}

/** Connect within `timeoutMs`. Never throws. */
export function probe(host: string, port: number, options: { timeoutMs: number }): Promise<ProbeResult> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.connect({ host, port });
    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ status: "timeout", ms: elapsed() }), options.timeoutMs);
    socket.once("connect", () => finish({ status: "open", ms: elapsed() }));
    socket.once("error", () => finish({ status: "closed", ms: elapsed() }));
  });
}
