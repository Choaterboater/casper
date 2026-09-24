import dgram from "node:dgram";
import { Attribute, Code, decodePacket, encodeAccessRequest } from "./packet";

export interface RadiusTestOptions {
  readonly host: string;
  readonly port?: number;
  readonly secret: string;
  readonly username: string;
  readonly password: string;
  readonly nasIdentifier?: string;
  readonly timeoutMs?: number;
  readonly retries?: number;
}

export type RadiusStatus = "accept" | "reject" | "challenge" | "timeout" | "bad-response";

export interface RadiusResult {
  readonly status: RadiusStatus;
  readonly attempts: number;
  readonly replyMessages: string[];
  readonly arubaUserRole: string | null;
  readonly ciscoAvPairs: string[];
}

// TODO: validate the Response Authenticator, retransmit on timeout, decode the vendor attributes.
export function radiusTest(options: RadiusTestOptions): Promise<RadiusResult> {
  const request = encodeAccessRequest(options);
  const socket = dgram.createSocket("udp4");
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.close();
      resolve({ status: "timeout", attempts: 1, replyMessages: [], arubaUserRole: null, ciscoAvPairs: [] });
    }, options.timeoutMs ?? 2000);
    socket.on("message", (data) => {
      const packet = decodePacket(data);
      if (!packet) return;
      clearTimeout(timer);
      socket.close();
      const replyMessages = packet.attributes.filter((attribute) => attribute.type === Attribute.ReplyMessage).map((attribute) => attribute.value.toString());
      resolve({ status: packet.code === Code.AccessAccept ? "accept" : "reject", attempts: 1, replyMessages, arubaUserRole: null, ciscoAvPairs: [] });
    });
    socket.send(request.packet, options.port ?? 1812, options.host);
  });
}
