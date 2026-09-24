import net from "node:net";
import tls from "node:tls";

export type Status = "open" | "closed" | "timeout" | "tls-error";

export interface TlsInfo {
  readonly expires: string;
  readonly daysLeft: number;
}

export interface ProbeResult {
  readonly status: Status;
  readonly ms: number;
  readonly tls?: TlsInfo;
}

const DAY_MS = 86_400_000;

/** Connect (and optionally complete a TLS handshake) within `timeoutMs`. Never throws. */
export function probe(host: string, port: number, options: { timeoutMs: number; tls: boolean }): Promise<ProbeResult> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  return new Promise((resolve) => {
    let settled = false;
    const socket: net.Socket = options.tls
      ? tls.connect({ host, port, rejectUnauthorized: false, ...(net.isIP(host) ? {} : { servername: host }) })
      : net.connect({ host, port });
    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ status: "timeout", ms: elapsed() }), options.timeoutMs);
    let connected = false;
    socket.once("connect", () => {
      connected = true;
      if (!options.tls) finish({ status: "open", ms: elapsed() });
    });
    if (options.tls) {
      socket.once("secureConnect", () => {
        const certificate = (socket as tls.TLSSocket).getPeerCertificate();
        const expires = new Date(certificate.valid_to);
        if (!certificate.valid_to || Number.isNaN(expires.getTime())) return finish({ status: "tls-error", ms: elapsed() });
        finish({
          status: "open", ms: elapsed(),
          tls: { expires: expires.toISOString(), daysLeft: Math.floor((expires.getTime() - Date.now()) / DAY_MS) },
        });
      });
    }
    socket.once("error", () => finish({ status: connected && options.tls ? "tls-error" : "closed", ms: elapsed() }));
    socket.once("close", () => finish({ status: connected && options.tls ? "tls-error" : "closed", ms: elapsed() }));
  });
}
