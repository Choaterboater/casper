import dgram from "node:dgram";
import { Attribute, Code, decodePacket, encodeAccessRequest, md5, type Packet } from "./packet";

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

const VENDOR_CISCO = 9;
const VENDOR_ARUBA = 14823;

function validAuthenticator(packet: Packet, requestAuthenticator: Buffer, secret: string): boolean {
  const header = Buffer.from([packet.code, packet.identifier, 0, 0]);
  header.writeUInt16BE(20 + packet.attributeBytes.length, 2);
  const expected = md5(header, requestAuthenticator, packet.attributeBytes, Buffer.from(secret, "utf8"));
  return expected.equals(packet.authenticator);
}

/** Cisco-AVPairs, the first Aruba-User-Role and every Reply-Message. */
export function readAttributes(packet: Packet): Pick<RadiusResult, "replyMessages" | "arubaUserRole" | "ciscoAvPairs"> {
  const replyMessages: string[] = [];
  const ciscoAvPairs: string[] = [];
  let arubaUserRole: string | null = null;
  for (const attribute of packet.attributes) {
    if (attribute.type === Attribute.ReplyMessage) replyMessages.push(attribute.value.toString("utf8"));
    if (attribute.type !== Attribute.VendorSpecific || attribute.value.length < 4) continue;
    const vendor = attribute.value.readUInt32BE(0);
    for (let offset = 4; offset + 2 <= attribute.value.length;) {
      const type = attribute.value[offset]!;
      const size = attribute.value[offset + 1]!;
      if (size < 2 || offset + size > attribute.value.length) break;
      const text = attribute.value.subarray(offset + 2, offset + size).toString("utf8");
      if (vendor === VENDOR_CISCO && type === 1) ciscoAvPairs.push(text);
      if (vendor === VENDOR_ARUBA && type === 1 && arubaUserRole === null) arubaUserRole = text;
      offset += size;
    }
  }
  return { replyMessages, arubaUserRole, ciscoAvPairs };
}

const STATUS: Record<number, RadiusStatus> = { [Code.AccessAccept]: "accept", [Code.AccessReject]: "reject", [Code.AccessChallenge]: "challenge" };

export function radiusTest(options: RadiusTestOptions): Promise<RadiusResult> {
  const port = options.port ?? 1812;
  const timeoutMs = options.timeoutMs ?? 2000;
  const retries = options.retries ?? 2;
  const request = encodeAccessRequest(options);
  const socket = dgram.createSocket(options.host.includes(":") ? "udp6" : "udp4");
  return new Promise((resolve, reject) => {
    let attempts = 0;
    let forged = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const finish = (result: RadiusResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.close();
      resolve(result);
    };
    const empty = { replyMessages: [], arubaUserRole: null, ciscoAvPairs: [] };
    const send = () => {
      attempts++;
      socket.send(request.packet, port, options.host, (error) => {
        if (error && !done) { done = true; clearTimeout(timer); socket.close(); reject(error); }
      });
      timer = setTimeout(() => {
        if (attempts <= retries) send();
        else finish({ status: forged ? "bad-response" : "timeout", attempts, ...empty });
      }, timeoutMs);
    };
    socket.on("message", (data) => {
      const packet = decodePacket(data);
      if (!packet || packet.identifier !== request.identifier) return;
      if (!validAuthenticator(packet, request.authenticator, options.secret)) { forged = true; return; }
      const status = STATUS[packet.code];
      if (!status) return;
      finish({ status, attempts, ...readAttributes(packet) });
    });
    socket.on("error", (error) => { if (!done) { done = true; clearTimeout(timer); socket.close(); reject(error); } });
    send();
  });
}
